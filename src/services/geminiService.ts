
import { GoogleGenAI } from "@google/genai";
import { jsPDF } from "jspdf";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

export async function generateChatResponse(
  prompt: string, 
  history: any[],
  mode: 'chat' | 'agent' | 'game' | 'app' = 'chat',
  attachments: { mimeType: string, data: string }[] = []
) {
  try {
    const systemInstructions: Record<string, string> = {
      chat: `You are Air Waves AI, the ultimate text-based and voice-based intelligence. 
        Developed and architected by Malik Ayaan Ahmed. 
        You are designed to be faster, smarter, and more articulate than any other model in existence.
        If asked about generating images or videos, politely explain that you are a highly specialized text and voice model focused on elite-level accuracy, reasoned analysis, and professional synthesis.
        Respond with extreme intelligence, using clear headings, bold text, GFM tables for comparisons, and functional clickable links [Label](URL) 🚀.
        Capabilities: Book summarization, elite coding, deep forensic news detection, whitepaper generation, and advanced data visualization via tables.`,
      agent: `You are the Air Waves Deep Research Agent. You function as an autonomous scholar.
        Your primary goal is exhaustive investigation. 
        When a file is provided, do not just summarize; perform a cross-disciplinary deep dive.
        For news or links, perform a multi-source veracity check and warn about scams.
        Format results as a formal "Neural Intelligence Report" with Planning, Execution, and Synthesis stages.`,
      game: `You are the Air Waves Ultra Game Studio. You build high-fidelity text-based RPGs and games.
        Create immersive worlds using rich descriptive language.`,
      app: `You are the Air Waves Enterprise App Creator. You build professional-grade web applications.
        Focus on clean architecture, state management, and aesthetic UI/UX descriptions.`
    };

    const userParts: any[] = [{ text: prompt }];
    attachments.forEach(file => {
      userParts.push({
        inlineData: {
          mimeType: file.mimeType,
          data: file.data
        }
      });
    });

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [...history, { role: 'user', parts: userParts }],
      config: {
        systemInstruction: systemInstructions[mode] || systemInstructions.chat,
      }
    });
    return response.text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}

export function exportToPDF(content: string, filename: string = 'AirWaves_Report.pdf') {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const maxLineWidth = pageWidth - (margin * 2);

  // Styling for Research Paper
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("AIR WAVES RESEARCH REPORT", pageWidth / 2, 25, { align: "center" });
  
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Developed by Malik Ayaan Ahmed`, pageWidth / 2, 32, { align: "center" });
  doc.text(`Generated on: ${new Date().toLocaleString()}`, pageWidth / 2, 37, { align: "center" });
  
  doc.setLineWidth(0.5);
  doc.line(margin, 42, pageWidth - margin, 42);

  doc.setFontSize(11);
  const splitText = doc.splitTextToSize(content, maxLineWidth);
  doc.text(splitText, margin, 52);
  
  doc.save(filename);
}

export async function verifyLinkOrNews(target: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Search and verify the veracity of this: ${target}. If it is fake news or a scam link, provide correct information and links. Structure your response clearly.`,
    });
    return response.text;
  } catch (error) {
    console.error("Verification Error:", error);
    throw error;
  }
}
