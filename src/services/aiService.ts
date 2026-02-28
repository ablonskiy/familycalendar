import OpenAI from "openai";

const getOpenRouter = () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing in environment variables.");
  }
  return new OpenAI({
    apiKey: apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Family Calendar Bot",
    }
  });
};

export interface ParsedEvent {
  title: string;
  date: string; // ISO format
  time: string; // HH:mm
  durationMinutes: number;
  location: string;
  description: string;
}

export type Intent = 'ADD' | 'QUERY';

export interface AIResponse {
  intent: Intent;
  event?: ParsedEvent;
  query?: {
    startDate: string; // YYYY-MM-DD
    endDate: string;   // YYYY-MM-DD
  };
}

export async function parseEventMessage(message: string, currentTime: string, timezone: string): Promise<AIResponse> {
  const openai = getOpenRouter();
  
  const prompt = `Current Time: ${currentTime} (UTC). Timezone: ${timezone}.
  Analyze this message: "${message}".
  Determine if the user wants to ADD an event to the calendar or QUERY (list) existing events.
  
  Return a JSON object with these keys:
  - intent: "ADD" or "QUERY"
  
  If intent is "ADD", include "event" object:
    - title: (string) Event name in Russian
    - date: (string) YYYY-MM-DD
    - time: (string) HH:mm
    - durationMinutes: (number) duration in minutes (default 60)
    - location: (string) location or empty string
    - description: (string) additional details or empty string
    
  If intent is "QUERY", include "query" object:
    - startDate: (string) YYYY-MM-DD
    - endDate: (string) YYYY-MM-DD (same as startDate if single day)

  Rules:
  1. If year is missing, use year from ${currentTime}.
  2. If date is relative (e.g. "tomorrow", "next week"), calculate it based on ${currentTime}.
  3. Return ONLY the JSON object. No markdown, no explanation.`;

  const response = await openai.chat.completions.create({
    model: "google/gemini-2.0-flash-001",
    messages: [
      { role: "system", content: "You are a specialized calendar assistant. You output ONLY valid JSON." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
  });

  const content = response.choices[0].message.content || "{}";
  console.log("OpenRouter raw response:", content);
  
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON object found in response");
    
    const jsonStr = content.substring(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    
    if (parsed.intent === 'QUERY') {
      return {
        intent: 'QUERY',
        query: {
          startDate: parsed.query?.startDate || currentTime.split(' ')[0],
          endDate: parsed.query?.endDate || parsed.query?.startDate || currentTime.split(' ')[0]
        }
      };
    }

    return {
      intent: 'ADD',
      event: {
        title: parsed.event?.title || "Без названия",
        date: parsed.event?.date || currentTime.split(' ')[0],
        time: parsed.event?.time || "09:00",
        durationMinutes: Number(parsed.event?.durationMinutes) || 60,
        location: parsed.event?.location || "",
        description: parsed.event?.description || ""
      }
    };
  } catch (e) {
    console.error("Failed to parse OpenRouter response:", e, "Content:", content);
    throw new Error("Не удалось распознать намерение или данные.");
  }
}

export async function refineEventMessage(previousData: ParsedEvent, newMessage: string, currentTime: string): Promise<ParsedEvent> {
  const openai = getOpenRouter();
  
  const prompt = `Previous Event Data: ${JSON.stringify(previousData)}. 
  User refinement: "${newMessage}". 
  Current Time: ${currentTime}.
  
  Update the event data based on the refinement.
  Return a JSON object with the same keys: title, date, time, durationMinutes, location, description.
  Return ONLY the JSON object.`;

  const response = await openai.chat.completions.create({
    model: "google/gemini-2.0-flash-001",
    messages: [
      { role: "system", content: "You are a specialized data extractor. You output ONLY valid JSON. You never explain your output." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
  });

  const content = response.choices[0].message.content || "{}";
  console.log("OpenRouter raw refine response:", content);
  
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON object found in response");
    
    const jsonStr = content.substring(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    
    return {
      title: parsed.title || previousData.title,
      date: parsed.date || previousData.date,
      time: parsed.time || previousData.time,
      durationMinutes: Number(parsed.durationMinutes) || previousData.durationMinutes,
      location: parsed.location || previousData.location,
      description: parsed.description || previousData.description
    };
  } catch (e) {
    console.error("Failed to parse OpenRouter refine response:", e, "Content:", content);
    return previousData;
  }
}
