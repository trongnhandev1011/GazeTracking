import { useEffect, useState } from "react";
import { CreateMLCEngine } from "@mlc-ai/web-llm";

export function useLocalLLM() {
  const [engine, setEngine] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        console.log("Loading local LLM...");
        // Use one of these valid model IDs:
        const eng = await CreateMLCEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC");
        // Alternative models:
        // "Llama-3.2-3B-Instruct-q4f16_1-MLC"
        // "Phi-3.5-mini-instruct-q4f16_1-MLC"
        // "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"

        setEngine(eng);
        setLoading(false);
      } catch (err) {
        console.error("Failed to load LLM:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    }
    load();
  }, []);

  async function ask(prompt: string) {
    if (!engine) return "";
    try {
      const out = await engine.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
      });
      console.log("out", out);
      return out.choices[0].message.content;
    } catch (err) {
      console.error("Error during inference:", err);
      return "Error generating response";
    }
  }

  return { ask, loading, error };
}
