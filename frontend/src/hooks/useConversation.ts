"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getApiErrorMessage,
  getConversation,
  getErrorConversationState,
  getFriendlyErrorMessage,
  getSavedGuestMessage,
  sendChatMessage,
  type Conversation,
  type ConversationWithMessages,
  type Message,
} from "@/lib/api";
import type { ChatUiEvent } from "@/lib/chat-ui";

// Loads a conversation from the API and sends guest messages to it.
// The database stays the source of truth: this state is only a copy of it.
export function useConversation(conversationId: string) {
  const [conversation, setConversation] =
    useState<ConversationWithMessages | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSending, setIsSending] = useState(false);
  // Text the guest just sent, shown as "Sending..." until the API saves it
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    // Ignore the response if this effect was cleaned up before it arrived
    let ignore = false;

    getConversation(conversationId)
      .then((data) => {
        if (!ignore) setConversation(data);
      })
      .catch((error: unknown) => {
        if (!ignore) setLoadError(error);
      });

    return () => {
      ignore = true;
    };
  }, [conversationId, loadAttempt]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const appendMessages = useCallback((newMessages: Message[]) => {
    setConversation((current) =>
      current
        ? { ...current, messages: [...current.messages, ...newMessages] }
        : current,
    );
  }, []);

  // Keep the status in step with the API, so a blocked chat hides the input
  const updateState = useCallback(
    (state: Pick<Conversation, "status" | "warningCount">) => {
      setConversation((current) => (current ? { ...current, ...state } : current));
    },
    [],
  );

  const dismissSendError = useCallback(() => setSendError(null), []);

  // Replace one message's ui event, for example once its proposal is accepted
  const updateMessageUi = useCallback((messageId: string, ui: ChatUiEvent) => {
    setConversation((current) =>
      current
        ? {
            ...current,
            messages: current.messages.map((message) => (message.id === messageId ? { ...message, ui } : message)),
          }
        : current,
    );
  }, []);

  // Show one message the backend already saved, such as the agent's reply to a
  // proposal card's button
  const addMessage = useCallback((message: Message) => appendMessages([message]), [appendMessages]);

  // Returns true once the guest message is saved, so the input knows to clear
  const sendMessage = useCallback(
    async (content: string) => {
      setIsSending(true);
      setSendError(null);
      setPendingContent(content);

      try {
        const { guestMessage, agentMessage, warningCount, conversationStatus, ui } =
          await sendChatMessage(conversationId, content);

        // Only show messages after the API has saved them. The reply carries
        // its own ui event (or null), so its card renders inside it.
        appendMessages([guestMessage, { ...agentMessage, ui }]);
        updateState({ status: conversationStatus, warningCount });
        return true;
      } catch (error) {
        const state = getErrorConversationState(error);
        if (state) updateState(state);

        setSendError(getApiErrorMessage(error));

        // Claude failed, but the guest message was saved: show it, no fake reply
        const savedGuestMessage = getSavedGuestMessage(error);
        if (savedGuestMessage) {
          appendMessages([savedGuestMessage]);
          return true;
        }

        return false;
      } finally {
        setPendingContent(null);
        setIsSending(false);
      }
    },
    [conversationId, appendMessages, updateState],
  );

  return {
    conversation,
    isLoading: !conversation && !loadError,
    loadErrorMessage: loadError ? getFriendlyErrorMessage(loadError) : null,
    canRetryLoad: !(loadError instanceof ApiError && loadError.status === 404),
    retryLoad,
    isSending,
    pendingContent,
    updateMessageUi,
    addMessage,
    sendError,
    dismissSendError,
    sendMessage,
  };
}
