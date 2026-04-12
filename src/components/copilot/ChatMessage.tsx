"use client";

import { motion } from "framer-motion";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface ChatMessageProps {
  message: Message;
  index: number;
}

function renderContent(content: string) {
  // Simple markdown-like rendering: bold (**text**), bullet lists, line breaks
  const lines = content.split("\n");

  return lines.map((line, i) => {
    // Bullet list
    if (line.trim().startsWith("- ") || line.trim().startsWith("• ")) {
      const text = line.trim().replace(/^[-•]\s+/, "");
      return (
        <li key={i} className="ml-3 list-disc marker:text-[#1B3A5C]">
          {renderInline(text)}
        </li>
      );
    }
    // Numbered list
    if (/^\d+\.\s/.test(line.trim())) {
      const text = line.trim().replace(/^\d+\.\s+/, "");
      return (
        <li key={i} className="ml-3 list-decimal marker:text-[#1B3A5C]">
          {renderInline(text)}
        </li>
      );
    }
    // Empty line
    if (line.trim() === "") {
      return <div key={i} className="h-2" />;
    }
    // Normal line
    return <p key={i}>{renderInline(line)}</p>;
  });
}

function renderInline(text: string): React.ReactNode {
  // Bold: **text**
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

export default function ChatMessage({ message, index }: ChatMessageProps) {
  const isUser = message.role === "user";

  const timeStr = message.timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, delay: 0, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "flex w-full gap-3",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full shadow-sm",
          isUser
            ? "bg-[#1B3A5C] text-white"
            : "border border-[#DDD9D0] bg-white text-[#1B3A5C]"
        )}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Bubble */}
      <div
        className={cn(
          "max-w-[78%] space-y-1",
          isUser ? "items-end" : "items-start"
        )}
      >
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm",
            isUser
              ? "rounded-tr-sm bg-[#1B3A5C] text-white"
              : "rounded-tl-sm border border-[#DDD9D0] bg-white text-foreground"
          )}
        >
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <div className="space-y-1">{renderContent(message.content)}</div>
          )}
        </div>
        <p
          className={cn(
            "px-1 text-[10px] text-muted-foreground",
            isUser ? "text-right" : "text-left"
          )}
        >
          {timeStr}
        </p>
      </div>
    </motion.div>
  );
}

// Typing indicator component
export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="flex gap-3"
    >
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[#DDD9D0] bg-white text-[#1B3A5C]">
        <Bot size={14} />
      </div>
      <div className="rounded-2xl rounded-tl-sm border border-[#DDD9D0] bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-2 w-2 rounded-full bg-[#1B3A5C]/40"
              animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                delay: i * 0.2,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
