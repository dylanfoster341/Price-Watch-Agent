"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ChatMessage = { role: "user" | "assistant"; content: string };

const INTRO: ChatMessage = {
  role: "assistant",
  content:
    "Discount Detective, on the case. Give me some stores to stake out — " +
    "\"watch Best Buy and Target\" works — then ask me to check a price. " +
    "I've seen every fake markdown in the business.",
};

export default function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([INTRO]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }

      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
      <header className="shrink-0 border-b border-black/10 py-4 dark:border-white/10">
        <h1 className="text-lg font-semibold tracking-tight">🕵️ Price Watch Agent</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Deadpan price comparisons, one store at a time.
        </p>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {messages.map((m, i) => (
          <ChatBubble key={i} message={m} />
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-black/5 px-4 py-2 text-sm text-black/50 dark:bg-white/10 dark:text-white/50">
              Working the case…
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      <form onSubmit={sendMessage} className="shrink-0 border-t border-black/10 py-4 dark:border-white/10">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(e);
              }
            }}
            rows={1}
            placeholder="Watch Best Buy and Target, then ask about a price…"
            className="flex-1 resize-none rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="shrink-0 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-sm bg-foreground px-4 py-2 text-sm text-background"
            : "max-w-[85%] rounded-2xl rounded-bl-sm bg-black/5 px-4 py-2 text-sm dark:bg-white/10"
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="[&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ ...props }) => (
                  <a
                    {...props}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
                  />
                ),
                table: ({ ...props }) => (
                  <div className="my-2 overflow-x-auto">
                    <table {...props} className="w-full border-collapse text-left" />
                  </div>
                ),
                th: ({ ...props }) => (
                  <th
                    {...props}
                    className="border border-black/10 bg-black/5 px-2 py-1 font-medium dark:border-white/15 dark:bg-white/10"
                  />
                ),
                td: ({ ...props }) => (
                  <td {...props} className="border border-black/10 px-2 py-1 align-top dark:border-white/15" />
                ),
                strong: ({ ...props }) => <strong {...props} className="font-semibold" />,
                code: ({ ...props }) => (
                  <code {...props} className="rounded bg-black/10 px-1 py-0.5 text-xs dark:bg-white/15" />
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
