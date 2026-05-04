
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  url: string;
  type: string;
}

export interface ChatSession {
  id: string;
  title: string;
  lastMessageAt: number;
  createdAt: number;
  userId: string;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  createdAt: number;
  role?: 'user' | 'admin';
}
