
import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Plus, Mic, Paperclip, X, Menu, Settings, LogOut, MessageSquare, User, Sparkles, Wand2, Gamepad2, Laptop, MoreHorizontal, Copy, Square, Download, Maximize, ShieldCheck, AlertTriangle, Search, FileText, Play, Image as ImageIcon } from 'lucide-react';
import { auth, loginWithGoogle, logout, db, loginAnonymously } from '@/src/lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
  getDocs,
  setDoc
} from 'firebase/firestore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { generateChatResponse, exportToPDF } from '@/src/services/geminiService';
import { VoiceChat } from '@/src/components/VoiceChat';
import type { Message, ChatSession } from '@/src/types';

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mode, setMode] = useState<'chat' | 'agent' | 'game' | 'app'>('chat');
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{file: File, preview: string, type: string, base64: string}[]>([]);
  const [isVoiceChatOpen, setIsVoiceChatOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Abort controller for stopping AI response
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Ensure user document exists in Firestore
        try {
          const userRef = doc(db, 'users', u.uid);
          // Just update/set basic info
          await updateDoc(userRef, {
            uid: u.uid,
            email: u.email,
            lastLoginAt: Date.now()
          }).catch(async (err) => {
            if (err.code === 'not-found') {
              await setDoc(userRef, {
                uid: u.uid,
                email: u.email,
                createdAt: Date.now(),
                lastLoginAt: Date.now()
              });
            }
          });
        } catch (err) {
          console.error("Profile sync error:", err);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch real chats from Firestore
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'chats'),
      where('userId', '==', user.uid)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const chatList = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as ChatSession))
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
      setChats(chatList);
    }, (error) => {
       console.error("Chats listener error:", error);
    });
    return () => unsubscribe();
  }, [user]);

  // Fetch messages for active chat
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, `chats/${activeChatId}/messages`),
      where('userId', '==', user.uid)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgList = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Message))
        .sort((a, b) => a.timestamp - b.timestamp);
      setMessages(msgList);
    }, (error) => {
      console.error("Messages listener error:", error);
    });
    return () => unsubscribe();
  }, [activeChatId, user]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = (event.target?.result as string).split(',')[1];
        const preview = event.target?.result as string;
        setPendingFiles(prev => [...prev, {
          file,
          preview: file.type.startsWith('image/') ? preview : '',
          type: file.type,
          base64
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if ((!inputText.trim() && pendingFiles.length === 0) || isTyping) return;

    if (mode === 'agent') {
      setAgentStatus('Initiating Deep Research Engine...');
    }

    let chatId = activeChatId;
    
    // Create new chat if none active
    if (!chatId && user) {
      const chatDoc = await addDoc(collection(db, 'chats'), {
        userId: user.uid,
        title: (mode === 'agent' ? 'Research: ' : '') + (inputText.slice(0, 30) || 'Multi-modal research') + '...',
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        mode: mode
      });
      chatId = chatDoc.id;
      setActiveChatId(chatId);
    }

    if (!chatId || !user) return;

    const attachments = pendingFiles.map(f => ({
      mimeType: f.type,
      data: f.base64,
      name: f.file.name
    }));

    // Construct a content string that includes file context for future history turns
    const fileContext = attachments.length > 0 
      ? `\n\n[Analyzed Files: ${attachments.map(a => a.name).join(', ')}]` 
      : '';
    
    const displayContent = inputText + fileContext;

    const userMsg: any = {
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
      chatId: chatId,
      userId: user.uid,
      attachments: attachments.map(a => ({ mimeType: a.mimeType, data: a.data, name: a.name }))
    };

    await addDoc(collection(db, `chats/${chatId}/messages`), userMsg);
    
    setInputText('');
    setPendingFiles([]);
    setIsTyping(true);
    
    abortControllerRef.current = new AbortController();

    try {
      if (mode === 'agent') setAgentStatus('Initiating Deep Multi-modal Research...');
      
      // Fetch deep history for context
      const historyQ = query(
        collection(db, `chats/${chatId}/messages`),
        where('userId', '==', user.uid)
      );
      const historySnapshot = await getDocs(historyQ);
      const history = historySnapshot.docs
        .map(doc => doc.data())
        .filter(data => data.timestamp < userMsg.timestamp)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(data => ({
          role: data.role === 'user' ? 'user' as const : 'model' as const,
          parts: [{ text: data.content }]
        }));
      
      const response = await generateChatResponse(displayContent, history, mode, attachments);
      
      if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) return;

      const assistantMsg = {
        role: 'assistant',
        content: response || "Analysis complete.",
        timestamp: Date.now(),
        chatId: chatId,
        userId: user.uid
      };
      
      await addDoc(collection(db, `chats/${chatId}/messages`), assistantMsg);
      await updateDoc(doc(db, 'chats', chatId), { lastMessageAt: Date.now() });
      
    } catch (error) {
      console.error(error);
    } finally {
      setIsTyping(false);
      setAgentStatus(null);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsTyping(false);
    }
  };

  const handleVoiceTranscript = async (role: 'user' | 'assistant', text: string) => {
    if (!activeChatId || !user) return;
    try {
      await addDoc(collection(db, `chats/${activeChatId}/messages`), {
        role,
        content: text,
        timestamp: Date.now(),
        chatId: activeChatId,
        userId: user.uid
      });
      await updateDoc(doc(db, 'chats', activeChatId), { lastMessageAt: Date.now() });
    } catch (err) {
      console.error("Voice transcript update error:", err);
    }
  };

  const handleGuestLogin = async () => {
    try {
      await loginAnonymously();
    } catch (error) {
      console.error("Guest login failed:", error);
    }
  };

  if (!user) {
    return <LoginView onGoogleLogin={loginWithGoogle} onGuestLogin={handleGuestLogin} />;
  }

  return (
    <div className="flex h-screen w-full bg-white relative overflow-hidden font-sans">
      <AuraBackground />
      
      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <Sidebar 
        isOpen={isSidebarOpen} 
        setIsOpen={setIsSidebarOpen} 
        user={user} 
        onLogout={logout}
        currentMode={mode}
        setMode={setMode}
        chats={chats}
        activeChatId={activeChatId}
        setActiveChatId={setActiveChatId}
        setMessages={setMessages}
        setChats={setChats}
      />

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 w-full">
        {/* Header */}
        <header className="fixed top-0 left-0 right-0 h-16 flex items-center justify-between px-4 lg:px-8 bg-white/50 backdrop-blur-md z-30">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-xl font-display font-semibold tracking-tight">
              {mode === 'chat' && 'Air Waves'}
              {mode === 'agent' && 'Agentic Model'}
              {mode === 'game' && 'Game Studio'}
              {mode === 'app' && 'App Creator'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                navigator.share({
                  title: 'AI Studio Build: Air Waves',
                  url: window.location.href
                }).catch(() => {
                  navigator.clipboard.writeText(window.location.href);
                });
              }} 
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-500 hidden md:flex" 
              title="Share App"
            >
              <MoreHorizontal size={20} />
            </button>
            <button 
              onClick={() => {
                setActiveChatId(null);
                setMessages([]);
              }}
              className="px-3 py-1.5 bg-black text-white rounded-lg text-xs font-bold hover:scale-105 active:scale-95 transition-all flex items-center gap-2"
            >
              <Plus size={14} />
              NEW CHAT
            </button>
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-400 to-fuchsia-400 p-[2px]">
              <div className="w-full h-full rounded-full bg-white overflow-hidden">
                <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`} alt="User" />
              </div>
            </div>
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto px-4 pt-24 pb-48 lg:px-24">
          <div className="max-w-4xl mx-auto space-y-8">
            {messages.length === 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-20"
              >
                <h2 className="text-5xl font-display font-bold text-gray-900 mb-4 tracking-tighter relative inline-block">
                  Air Waves
                  <div className="absolute -bottom-2 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-purple-500 to-pink-500 rounded-full" />
                </h2>
                <p className="text-gray-500 font-medium">Ultra-Advanced High Level AI Model</p>
                <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto cursor-pointer">
                  {['Summarize a complex book', 'Perform deep research', 'Write elite code solutions', 'Analyze news veracity'].map((item) => (
                    <div 
                      key={item}
                      onClick={() => setInputText(item)}
                      className="p-6 bg-white/80 border border-gray-100 rounded-2xl shadow-sm hover:shadow-md hover:border-purple-200 transition-all text-left group"
                    >
                      <p className="text-sm font-semibold text-gray-800 group-hover:text-purple-600">{item}</p>
                      <p className="text-xs text-gray-500 mt-1">One-click to start</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
            
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`max-w-[90%] ${
                    msg.role === 'user' 
                      ? 'px-5 py-4 rounded-3xl bg-gray-100 text-gray-800 self-end' 
                      : 'text-gray-900 self-start w-full'
                  }`}
                >
                  <div className="flex flex-col gap-3">
                    {/* Render Attachments */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.attachments.map((file: any, idx: number) => (
                          <div key={idx} className="relative group/att">
                            {file.mimeType.startsWith('image/') ? (
                              <div className="relative">
                                <img 
                                  src={file.data} 
                                  alt={file.name}
                                  className="h-32 w-32 object-cover rounded-2xl border border-gray-100 shadow-sm"
                                />
                                <a 
                                  href={file.data} 
                                  download={file.name}
                                  className="absolute top-1 right-1 p-1 bg-white/80 rounded-full shadow-sm text-gray-600 opacity-0 group-hover/att:opacity-100 transition-opacity"
                                >
                                  <Download size={10} />
                                </a>
                              </div>
                            ) : (
                              <div className="h-32 w-32 flex flex-col items-center justify-center bg-gray-50 rounded-2xl border border-gray-100 p-3">
                                <FileText size={24} className="text-purple-500 mb-2" />
                                <span className="text-[10px] text-center font-bold text-gray-500 truncate w-full">{file.name}</span>
                                <a href={file.data} download={file.name} className="mt-2 text-[8px] font-black text-purple-600 uppercase tracking-widest">Download</a>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                     {msg.role === 'assistant' ? (
                      <div className="markdown-body">
                         <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw]}
                            components={{
                              p: ({children}) => <div className="mb-4 leading-relaxed last:mb-0">{children}</div>,
                              pre: ({children}) => <div className="relative my-6">{children}</div>,
                              a: ({node, ...props}: any) => (
                                <a 
                                  {...props} 
                                  className="text-purple-600 font-bold underline hover:text-purple-800 transition-colors"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                />
                              ),
                              table: ({node, ...props}: any) => (
                                <div className="my-6 overflow-x-auto rounded-2xl border border-gray-100 shadow-sm">
                                  <table {...props} className="w-full text-sm text-left border-collapse" />
                                </div>
                              ),
                              thead: ({node, ...props}: any) => <thead {...props} className="bg-gray-50 border-b border-gray-100" />,
                              th: ({node, ...props}: any) => <th {...props} className="px-6 py-4 font-black uppercase tracking-widest text-[10px] text-gray-500" />,
                              td: ({node, ...props}: any) => <td {...props} className="px-6 py-4 text-gray-700 border-b border-gray-50 last:border-0" />,
                              img: ({node, ...props}: any) => {
                                const handleDownload = (e: React.MouseEvent) => {
                                  e.preventDefault();
                                  const link = document.createElement('a');
                                  link.href = props.src;
                                  link.download = `air-waves-${Date.now()}.png`;
                                  document.body.appendChild(link);
                                  link.click();
                                  document.body.removeChild(link);
                                };

                                return (
                                  <div className="my-4 rounded-2xl overflow-hidden border border-gray-100 shadow-lg bg-gray-50 relative group/img">
                                    <img 
                                      {...props} 
                                      className="w-full h-auto max-h-[600px] object-contain cursor-zoom-in" 
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                    />
                                    <div className="absolute top-4 right-4 opacity-0 group-hover/img:opacity-100 transition-opacity flex gap-2">
                                      <a 
                                        href={props.src}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="bg-white/90 backdrop-blur-sm p-2 rounded-xl shadow-xl border border-gray-100 text-gray-700 hover:text-purple-600 hover:scale-105 transition-all flex items-center gap-2 text-xs font-bold"
                                      >
                                        <Maximize size={14} />
                                        FULLSIZE
                                      </a>
                                      <button 
                                        onClick={handleDownload}
                                        className="bg-white/90 backdrop-blur-sm p-2 rounded-xl shadow-xl border border-gray-100 text-gray-700 hover:text-purple-600 hover:scale-105 transition-all flex items-center gap-2 text-xs font-bold"
                                      >
                                        <Download size={14} />
                                        DOWNLOAD
                                      </button>
                                    </div>
                                  </div>
                                );
                              },
                              code: ({node, inline, className, children, ...props}: any) => {
                                const match = /language-(\w+)/.exec(className || '');
                                const lang = match ? match[1] : '';
                                if (!inline) {
                                  return (
                                    <div className="rounded-2xl overflow-hidden border border-gray-100 shadow-xl my-6 group/code">
                                      <div className="flex items-center justify-between px-4 py-2 bg-[#1e1e1e] border-b border-white/5">
                                        <div className="flex items-center gap-2">
                                          <div className="flex gap-1.5">
                                            <div className="w-2.5 h-2.5 rounded-full bg-red-400/50" />
                                            <div className="w-2.5 h-2.5 rounded-full bg-amber-400/50" />
                                            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/50" />
                                          </div>
                                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-2">{lang || 'code'}</span>
                                        </div>
                                        <button 
                                          onClick={() => navigator.clipboard.writeText(String(children).replace(/\n$/, ''))}
                                          className="p-1 px-2 text-[10px] font-bold text-gray-400 hover:text-white hover:bg-white/10 rounded transition-all flex items-center gap-1.5"
                                          title="Copy Code"
                                        >
                                          <Copy size={12} />
                                          COPY
                                        </button>
                                      </div>
                                      <SyntaxHighlighter
                                        language={lang || 'text'}
                                        style={vscDarkPlus}
                                        customStyle={{
                                          margin: 0,
                                          padding: '1.5rem',
                                          fontSize: '0.875rem',
                                          lineHeight: '1.5',
                                          backgroundColor: '#1e1e1e',
                                        }}
                                        codeTagProps={{
                                          style: {
                                            fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
                                          }
                                        }}
                                      >
                                        {String(children).replace(/\n$/, '')}
                                      </SyntaxHighlighter>
                                    </div>
                                  );
                                }
                                return (
                                  <code className={`${className} bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded font-mono text-sm`} {...props}>
                                    {children}
                                  </code>
                                );
                              }
                            }}
                         >
                            {msg.content}
                         </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    )}
                  </div>
                </motion.div>
              </div>
            ))}
            
            {isTyping && (
              <div className="flex flex-col gap-3">
                {agentStatus && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.9 }} 
                    animate={{ opacity: 1, scale: 1 }} 
                    className="flex flex-col gap-2 p-4 bg-purple-50/50 border border-purple-100/50 rounded-2xl max-w-sm"
                  >
                    <div className="flex items-center gap-2 text-[10px] font-black text-purple-600 uppercase tracking-[0.2em]">
                      <Sparkles size={14} className="animate-pulse" />
                      Neural Processing Unit
                    </div>
                    <div className="text-xs font-semibold text-purple-900 leading-tight">
                      {agentStatus}
                    </div>
                    <div className="w-full bg-purple-100 h-1 rounded-full overflow-hidden">
                       <motion.div 
                         initial={{ width: "0%" }}
                         animate={{ width: "100%" }}
                         transition={{ duration: 3, repeat: Infinity }}
                         className="h-full bg-purple-500"
                       />
                    </div>
                  </motion.div>
                )}
                <div className="flex justify-start">
                  <div className="bg-gray-50 px-5 py-4 rounded-3xl animate-pulse flex gap-2">
                    <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce delay-75" />
                    <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce delay-150" />
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input area - Prompt Box */}
        <div className="fixed bottom-0 left-0 right-0 p-4 lg:p-8 z-40 bg-gradient-to-t from-white via-white/80 to-transparent">
          <div className="max-w-4xl mx-auto flex flex-col items-center">
            
            {/* File Previews */}
            <AnimatePresence>
              {pendingFiles.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="w-full flex gap-2 mb-2 overflow-x-auto pb-2 scrollbar-none"
                >
                  {pendingFiles.map((pf, i) => (
                    <motion.div 
                      key={i}
                      layout
                      className="relative group/file shrink-0 w-20 h-20 rounded-2xl bg-gray-50 border border-gray-100 overflow-hidden shadow-sm"
                    >
                      {pf.preview ? (
                        <img src={pf.preview} className="w-full h-full object-cover" alt="Preview" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center text-[8px] font-bold text-gray-500 uppercase">
                          {pf.type.startsWith('video/') ? (
                            <Play size={18} className="mb-1 text-red-500" />
                          ) : pf.type.includes('pdf') ? (
                            <FileText size={18} className="mb-1 text-orange-500" />
                          ) : (
                            <FileText size={18} className="mb-1 text-purple-500" />
                          )}
                          <div className="truncate w-full">{pf.file.name.split('.').pop()}</div>
                        </div>
                      )}
                      <button 
                        onClick={() => removeFile(i)}
                        className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full opacity-0 group-hover/file:opacity-100 transition-opacity"
                      >
                        <X size={10} />
                      </button>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="w-full relative group">
              {/* RGB Rotating Border */}
              <div className="rgb-rotating-border opacity-20 group-focus-within:opacity-100 transition-opacity" />
              
              <div className="relative flex items-end gap-2 bg-white rounded-[30px] p-2 border border-gray-100/50 shadow-2xl overflow-hidden ring-0">
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-3 text-gray-400 hover:text-purple-600 transition-colors"
                >
                  <Plus size={22} />
                  <input 
                    ref={fileInputRef}
                    type="file" 
                    multiple 
                    className="hidden" 
                    onChange={handleFileChange}
                  />
                </button>
                <textarea 
                  rows={1}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask Air Waves anything..."
                  className="flex-1 max-h-48 py-3 bg-transparent border-none focus:ring-0 outline-none shadow-none resize-none text-gray-700 font-medium placeholder-gray-400 focus:placeholder-transparent"
                />
                <div className="flex items-center pr-2 gap-1">
                  <button 
                    onClick={() => {
                      if (!activeChatId) {
                        alert("Please select or start a chat first to use Live Speech.");
                        return;
                      }
                      setIsVoiceChatOpen(true);
                    }}
                    className="p-2 text-gray-400 hover:text-cyan-600 transition-colors"
                  >
                    <Mic size={20} />
                  </button>
                  {isTyping ? (
                    <button 
                      onClick={handleStop}
                      className="p-3 rounded-2xl bg-black text-white hover:scale-105 active:scale-95 transition-all"
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button 
                      onClick={handleSend}
                      disabled={!inputText.trim() && pendingFiles.length === 0}
                      className={`p-2.5 rounded-2xl transition-all ${
                        (inputText.trim() || pendingFiles.length > 0)
                          ? 'bg-black text-white hover:scale-105 active:scale-95' 
                          : 'bg-gray-100 text-gray-300'
                      }`}
                    >
                      <Send size={18} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-3 text-[10px] font-medium text-gray-400 uppercase tracking-widest text-center">
              Air Waves can make mistakes. Developed by <span className="text-gray-900">Malik Ayaan Ahmed</span>
            </p>
          </div>
        </div>
      </main>

      <AnimatePresence>
        {isVoiceChatOpen && (
          <VoiceChat 
            onClose={() => setIsVoiceChatOpen(false)}
            chatId={activeChatId || ''}
            userId={user?.uid || ''}
            onTranscript={handleVoiceTranscript}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ 
  isOpen, 
  setIsOpen, 
  user, 
  onLogout, 
  currentMode, 
  setMode,
  chats,
  activeChatId,
  setActiveChatId,
  setMessages,
  setChats
}: any) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredChats = chats.filter((chat: any) => 
    chat.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  return (
    <motion.aside 
      initial={{ x: '-100%' }}
      animate={{ x: isOpen ? 0 : '-100%' }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className={`fixed top-0 left-0 h-full w-[280px] bg-white border-r border-gray-100 z-50 flex flex-col shadow-2xl lg:shadow-none lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full lg:relative lg:translate-x-0 lg:flex'}`}
    >
      <div className="p-6 flex items-center justify-between border-b border-gray-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-black flex items-center justify-center text-white font-bold">A</div>
          <span className="font-display font-bold text-lg tracking-tight">Air Waves</span>
        </div>
        <button onClick={() => setIsOpen(false)} className="lg:hidden">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div>
          <div className="px-2 mb-4">
            <div className="relative group">
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                <Search size={14} className="text-gray-400 group-focus-within:text-black transition-colors" />
              </div>
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search history..."
                className="w-full bg-gray-50 border-none rounded-xl py-2 pl-10 pr-4 text-xs font-medium focus:ring-1 focus:ring-gray-200 transition-all"
              />
            </div>
          </div>
          <h3 className="px-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Model Modes</h3>
          <div className="space-y-1">
            <ModeItem active={currentMode === 'chat'} icon={<MessageSquare size={18}/>} label="Standard Chat" onClick={() => setMode('chat')} />
            <ModeItem active={currentMode === 'agent'} icon={<Sparkles size={18}/>} label="Agentic Model" onClick={() => setMode('agent')} />
            <ModeItem active={currentMode === 'game'} icon={<Gamepad2 size={18}/>} label="Game Studio" onClick={() => setMode('game')} />
            <ModeItem active={currentMode === 'app'} icon={<Laptop size={18}/>} label="App Creator" onClick={() => setMode('app')} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between px-2 mb-3">
            <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Recent Chats</h3>
            <div className="flex items-center gap-2">
              <button 
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm('Delete all chat history permanently?')) {
                    try {
                      // We clear the state immediately for responsiveness
                      setChats([]);
                      setMessages([]);
                      setActiveChatId(null);
                      
                      const q = query(collection(db, 'chats'), where('userId', '==', user.uid));
                      const snapshot = await getDocs(q);
                      const deletePromises = snapshot.docs.map(d => deleteDoc(d.ref));
                      await Promise.all(deletePromises);
                    } catch (err) {
                      console.error("Error clearing chats:", err);
                    }
                  }
                }}
                className="text-[10px] font-bold text-red-500 hover:text-white hover:bg-red-500 transition-all bg-red-50 px-2.5 py-1 rounded-md border border-red-100 flex items-center gap-1"
              >
                <X size={10} />
                CLEAR ALL
              </button>
              <Plus 
                size={14} 
                className="text-gray-400 cursor-pointer hover:text-black" 
                onClick={() => { setActiveChatId(null); setIsOpen(false); }}
              />
            </div>
          </div>
          <div className="space-y-1">
            {filteredChats.map((chat: any) => (
              <div key={chat.id} className="relative group/chat">
                <button 
                  onClick={() => { setActiveChatId(chat.id); setIsOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all ${
                    activeChatId === chat.id ? 'bg-gray-100 text-black shadow-sm' : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full shrink-0 ${activeChatId === chat.id ? 'bg-black' : 'bg-gray-300'}`} />
                  <span className="truncate pr-8">{chat.title}</span>
                </button>
                <button
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm('Delete this chat and its history?')) {
                      try {
                        const chatIdToDelete = chat.id;
                        // Optimistic UI update
                        setChats((prev: any) => prev.filter((c: any) => c.id !== chatIdToDelete));
                        if (activeChatId === chatIdToDelete) {
                          setActiveChatId(null);
                          setMessages([]);
                        }
                        
                        await deleteDoc(doc(db, 'chats', chatIdToDelete));
                      } catch (err) {
                        console.error("Error deleting chat:", err);
                        // Re-fetch or revert if failed? For now just log.
                      }
                    }
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-red-500 opacity-100 lg:opacity-0 lg:group-hover/chat:opacity-100 transition-opacity"
                  title="Delete Chat"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {filteredChats.length === 0 && searchQuery && (
              <div className="px-3 py-4 text-center">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">No results found</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-gray-50 bg-gray-50/50">
        <div className="flex items-center gap-3 p-2 rounded-2xl hover:bg-white transition-all group relative">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-400 to-fuchsia-400 p-[2px]">
            <div className="w-full h-full rounded-xl bg-white overflow-hidden">
               <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`} alt="Avatar" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900 truncate">{user.displayName || 'Air Waves User'}</p>
            <p className="text-xs text-gray-500 truncate">{user.email}</p>
          </div>
          <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-500 transition-colors">
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </motion.aside>
  );
}

function ModeItem({ active, icon, label, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all font-medium text-sm ${
        active 
          ? 'bg-black text-white shadow-lg shadow-black/10' 
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function AuraBackground() {
  return (
    <div className="aura-bg">
      <div className="aura-blob" style={{ top: '-10%', left: '-10%', animationDelay: '0s' }} />
      <div className="aura-blob" style={{ bottom: '-10%', right: '-10%', animationDelay: '-5s', background: 'linear-gradient(135deg, rgba(255, 0, 255, 0.4), rgba(255, 255, 0, 0.4))' }} />
      <div className="aura-blob" style={{ top: '30%', left: '40%', animationDelay: '-10s', background: 'linear-gradient(135deg, rgba(0, 0, 255, 0.2), rgba(0, 255, 0, 0.2))', width: '40vw', height: '40vw' }} />
    </div>
  );
}

function LoginView({ onGoogleLogin, onGuestLogin }: any) {
  return (
    <div className="h-screen w-full flex flex-col items-center justify-center p-6 bg-white relative overflow-hidden font-sans">
      <AuraBackground />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-white/80 backdrop-blur-xl p-10 rounded-[40px] shadow-2xl border border-white z-10 text-center"
      >
        <div className="w-20 h-20 bg-black text-white rounded-3xl flex items-center justify-center text-4xl font-bold mx-auto mb-8 shadow-xl">A</div>
        <h1 className="text-4xl font-display font-bold tracking-tight text-gray-900 mb-2">Welcome to Air Waves</h1>
        <p className="text-gray-500 mb-10 font-medium tracking-tight">The ultimate AI experience by Malik Ayaan Ahmed</p>
        
        <div className="space-y-4">
          <button 
            onClick={onGoogleLogin}
            className="w-full flex items-center justify-center gap-3 py-4 bg-white border border-gray-200 rounded-2xl font-bold text-gray-700 hover:bg-gray-50 hover:shadow-lg transition-all active:scale-[0.98]"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Continue with Google
          </button>
          
          <div className="grid grid-cols-3 gap-3">
             {['GitHub', 'Apple', 'Microsoft'].map(p => (
               <button key={p} className="flex flex-col items-center justify-center p-4 border border-gray-100 rounded-2xl hover:bg-gray-50 transition-all opacity-50 cursor-not-allowed">
                  <div className="w-6 h-6 bg-gray-200 rounded-md mb-2" />
                  <span className="text-[10px] font-bold text-gray-400">{p}</span>
               </button>
             ))}
          </div>

          <div className="relative my-8">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-100"></div></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-4 text-gray-400 font-bold tracking-widest">Or</span></div>
          </div>

          <button 
            onClick={onGuestLogin}
            className="w-full py-4 bg-black text-white rounded-2xl font-bold hover:shadow-xl hover:shadow-black/20 transition-all active:scale-[0.98]"
          >
            Continue as Guest
          </button>
        </div>
        
        <p className="mt-8 text-[11px] text-gray-400 font-medium">
          By signing in, you agree to our Terms of Service & Privacy Policy.
        </p>
      </motion.div>
    </div>
  );
}
