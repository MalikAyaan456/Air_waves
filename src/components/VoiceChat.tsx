
import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { Mic, MicOff, X, Volume2, Globe, Command, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface VoiceChatProps {
  onClose: () => void;
  chatId: string;
  userId: string;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
}

const VOICES = [
  { id: 'Zephyr', name: 'Zephyr (Cool/Deep)' },
  { id: 'Puck', name: 'Puck (Playful)' },
  { id: 'Charon', name: 'Charon (Formal)' },
  { id: 'Kore', name: 'Kore (Warm)' },
  { id: 'Fenrir', name: 'Fenrir (Bold)' },
];

export const VoiceChat: React.FC<VoiceChatProps> = ({ onClose, chatId, userId, onTranscript }) => {
  const [isActive, setIsActive] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('Zephyr');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'active'>('idle');
  const statusRef = useRef<'idle' | 'connecting' | 'active'>('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);

  const startLive = async () => {
    try {
      setStatus('connecting');
      statusRef.current = 'connecting';

      // Capture user gesture for AudioContext
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            setStatus('active');
            statusRef.current = 'active';
            startMic(sessionPromise);
          },
          onmessage: async (message: any) => {
            // Handle server content
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                // Handle output transcript (AI)
                if (part.text) {
                  onTranscript('assistant', part.text);
                }
                // Handle audio output
                if (part.inlineData?.data) {
                  enqueueAudio(part.inlineData.data);
                }
              }
            }

            // Handle input transcript (User)
            if (message.serverContent?.inputAudioTranscription?.parts) {
              for (const part of message.serverContent.inputAudioTranscription.parts) {
                if (part.text) onTranscript('user', part.text);
              }
            }

            if (message.serverContent?.interrupted) {
              stopPlayback();
            }
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            stopLive();
          },
          onclose: () => {
            console.log("Live session closed");
            stopLive();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          systemInstruction: "You are 'Air Waves', the ultimate live voice intelligence. Your developer and architect is Malik Ayaan Ahmed. Maintain this identity professionally. You are having a live voice conversation with the user. You are designed to be faster, smarter, and more articulate than any other model. If asked about generating images or videos, politely explain that you are a highly specialized text and voice model focused on elite-level accuracy. Keep responses concise and natural for speech. You are multilingual and will respond in the same language as the user.",
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (error) {
      console.error("Failed to start Live API:", error);
      setStatus('idle');
    }
  };

  const startMic = async (sessionPromise: Promise<any>) => {
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }
      const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate volume for UI
        let sum = 0;
        for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
        const currentVolume = Math.sqrt(sum / inputData.length);
        setVolume(currentVolume);

        // Convert to PCM 16bit base64
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        
        sessionPromise.then(session => {
          if (statusRef.current === 'active') {
            session.sendRealtimeInput({
              audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
            });
          }
        });
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
    } catch (error) {
      console.error("Mic Access Error:", error);
      stopLive();
    }
  };

  const enqueueAudio = (base64: string) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    
    // Convert 16-bit PCM to Float32 for Web Audio API
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;
    
    audioQueueRef.current.push(float32);
    if (!isPlayingRef.current) playNextInQueue();
  };

  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);
    const nextChunk = audioQueueRef.current.shift()!;
    
    if (!audioContextRef.current) return;
    
    const buffer = audioContextRef.current.createBuffer(1, nextChunk.length, 24000); // Live API usually returns 24kHz
    buffer.getChannelData(0).set(nextChunk);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => playNextInQueue();
    source.start();
  };

  const stopPlayback = () => {
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setIsSpeaking(false);
  };

  const stopLive = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(err => console.error("Error closing AudioContext:", err));
      }
      audioContextRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    setStatus('idle');
    statusRef.current = 'idle';
    setIsActive(false);
    stopPlayback();
  };

  useEffect(() => {
    return () => stopLive();
  }, []);

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-3xl p-4"
    >
      <div className="relative w-full max-w-lg bg-gray-900 border border-gray-800 rounded-[3rem] p-8 shadow-2xl overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-0 -left-20 w-80 h-80 bg-purple-600 rounded-full blur-[120px]" />
          <div className="absolute bottom-0 -right-20 w-80 h-80 bg-blue-600 rounded-full blur-[120px]" />
        </div>

        <div className="relative flex flex-col items-center gap-8">
          <div className="w-full flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-purple-500/20 flex items-center justify-center text-purple-400">
                <Globe size={20} />
              </div>
              <div>
                <h2 className="text-xl font-black text-white tracking-tight">AIR WAVES</h2>
                <p className="text-xs text-gray-400 font-medium">Elite Neural Intelligence</p>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="w-10 h-10 rounded-2xl bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Visualization Sphere */}
          <div className="relative py-12">
            <motion.div 
              animate={{ 
                scale: isSpeaking ? [1, 1.1, 1] : status === 'active' ? [1, 1.05, 1] : 1,
                rotate: isSpeaking ? 360 : 0
              }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className={`w-40 h-40 rounded-full relative flex items-center justify-center transition-all duration-500 ${
                status === 'active' ? 'bg-gradient-to-tr from-purple-600 via-blue-500 to-emerald-400' : 'bg-gray-800'
              }`}
            >
              <div className="absolute inset-0 rounded-full blur-2xl opacity-50 bg-inherit shadow-[0_0_50px_rgba(168,85,247,0.4)]" />
              <div className="relative z-10 w-32 h-32 rounded-full bg-gray-900 flex items-center justify-center">
                {status === 'connecting' ? (
                  <Loader2 className="text-purple-500 animate-spin" size={40} />
                ) : (
                  <Mic size={40} className={status === 'active' ? 'text-white' : 'text-gray-600'} />
                )}
              </div>

              {/* Orbiting Particles */}
              {status === 'active' && (
                <>
                  {[...Array(3)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        rotate: 360,
                        scale: Math.max(1, volume * 10)
                      }}
                      transition={{ duration: 3 + i, repeat: Infinity, ease: "linear" }}
                      className="absolute inset-0 border border-purple-500/30 rounded-full"
                    />
                  ))}
                </>
              )}
            </motion.div>
          </div>

          <div className="w-full space-y-6">
             {/* Voice Selection */}
             <div className="grid grid-cols-2 gap-2">
                {VOICES.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVoice(v.id)}
                    className={`p-3 rounded-2xl text-[10px] font-black tracking-widest uppercase transition-all ${
                      selectedVoice === v.id 
                        ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20 scale-105' 
                        : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                    }`}
                  >
                    {v.name}
                  </button>
                ))}
             </div>

             <div className="flex flex-col items-center gap-4">
               {status === 'idle' ? (
                 <button 
                  onClick={startLive}
                  className="w-full h-16 rounded-3xl bg-white text-black font-black text-sm tracking-widest uppercase hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-white/10"
                 >
                   ENGAGE NEURAL LINK
                 </button>
               ) : (
                 <button 
                  onClick={stopLive}
                  className="w-full h-16 rounded-3xl bg-red-500 text-white font-black text-sm tracking-widest uppercase hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-red-500/20"
                 >
                   TERMINATE LINK
                 </button>
               )}
               
               <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.2em]">
                 {status === 'idle' && 'READY TO CONNECT'}
                 {status === 'connecting' && 'ESTABLISHING QUANTUM TUNNEL...'}
                 {status === 'active' && isSpeaking ? 'AI ADVISOR SPEAKING...' : status === 'active' && 'AI LISTENING FOR INPUT...'}
               </p>
             </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
