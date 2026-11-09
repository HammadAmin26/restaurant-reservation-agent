"use client";

import { useEffect, useRef } from "react";
import type { Message } from "@/lib/api";
import type { ChatUiEvent } from "@/lib/chat-ui";
import { MessageBubble } from "./MessageBubble";
import { CancellationProposalCard } from "./CancellationProposalCard";
import { ModificationProposalCard } from "./ModificationProposalCard";
import { ReservationListCards } from "./ReservationListCards";
import { ReservationProposalCard } from "./ReservationProposalCard";
import { TypingIndicator } from "./TypingIndicator";

const WELCOME_MESSAGE =
  "Welcome to Hammad Foods! I'm here to help you reserve a table. What can I do for you today?";

type MessageListProps = {
  messages: Message[];
  // Guest message that is still being sent
  pendingContent: string | null;
  isAgentTyping: boolean;
  conversationId: string;
  // Called when a message's component changes, such as an accepted proposal
  onMessageUiChange: (messageId: string, ui: ChatUiEvent) => void;
  // Called with a message the backend saved outside a chat request, such as
  // the agent's reply to a proposal card's button
  onNewMessage: (message: Message) => void;
};

export function MessageList({
  messages,
  pendingContent,
  isAgentTyping,
  conversationId,
  onMessageUiChange,
  onNewMessage,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message (or the typing indicator) in view
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pendingContent, isAgentTyping]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ul className="flex flex-col gap-4" aria-live="polite">
          <MessageBubble role="agent" content={WELCOME_MESSAGE} />
          {messages.map((message) => (
            <MessageBubble key={message.id} role={message.role} content={message.content} createdAt={message.createdAt}>
              {message.ui?.type === "reservation_proposal" && (
                <ReservationProposalCard
                  conversationId={conversationId}
                  proposal={message.ui.data}
                  onChange={(data) => onMessageUiChange(message.id, { type: "reservation_proposal", data })}
                  onReply={onNewMessage}
                />
              )}
              {message.ui?.type === "modification_proposal" && (
                <ModificationProposalCard
                  conversationId={conversationId}
                  proposal={message.ui.data}
                  onChange={(data) => onMessageUiChange(message.id, { type: "modification_proposal", data })}
                  onReply={onNewMessage}
                />
              )}
              {message.ui?.type === "cancellation_proposal" && (
                <CancellationProposalCard
                  conversationId={conversationId}
                  proposal={message.ui.data}
                  onChange={(data) => onMessageUiChange(message.id, { type: "cancellation_proposal", data })}
                  onReply={onNewMessage}
                />
              )}
              {message.ui?.type === "reservation_list" && (
                <ReservationListCards reservations={message.ui.data.reservations} />
              )}
            </MessageBubble>
          ))}
          {pendingContent !== null && (
            <MessageBubble role="guest" content={pendingContent} isPending />
          )}
          {isAgentTyping && <TypingIndicator />}
        </ul>
        {messages.length === 0 && pendingContent === null && (
          <p className="mt-8 text-center text-sm text-muted">
            No messages yet. Send the first one below.
          </p>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
