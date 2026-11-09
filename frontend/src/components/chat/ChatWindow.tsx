"use client";

import { Toast } from "@/components/Toast";
import { useConversation } from "@/hooks/useConversation";
import { ChatError } from "./ChatError";
import { ChatLoading } from "./ChatLoading";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

type ChatWindowProps = {
  conversationId: string;
};

export function ChatWindow({ conversationId }: ChatWindowProps) {
  const {
    conversation,
    isLoading,
    loadErrorMessage,
    canRetryLoad,
    retryLoad,
    isSending,
    pendingContent,
    updateMessageUi,
    addMessage,
    sendError,
    dismissSendError,
    sendMessage,
  } = useConversation(conversationId);

  if (isLoading) {
    return <ChatLoading />;
  }

  if (!conversation) {
    return (
      <ChatError
        message={loadErrorMessage ?? "Something went wrong."}
        onRetry={canRetryLoad ? retryLoad : undefined}
      />
    );
  }

  return (
    <>
      <Toast message={sendError} onDismiss={dismissSendError} />
      <MessageList
        messages={conversation.messages}
        pendingContent={pendingContent}
        isAgentTyping={isSending}
        conversationId={conversationId}
        onMessageUiChange={updateMessageUi}
        onNewMessage={addMessage}
      />
      <div className="border-t border-line bg-cream">
        {conversation.status === "active" ? (
          <MessageInput isSending={isSending} onSend={sendMessage} />
        ) : (
          <p className="mx-auto w-full max-w-3xl px-4 py-5 text-center text-sm text-muted">
            {conversation.status === "blocked"
              ? "This conversation has been blocked after 3 warnings. Please start a new conversation."
              : "This conversation has ended."}
          </p>
        )}
      </div>
    </>
  );
}
