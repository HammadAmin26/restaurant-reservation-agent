// Client for the Express conversation API. Components call these functions
// instead of using fetch directly.

import type { ChatUiEvent } from "./chat-ui";

export type MessageRole = "guest" | "agent";

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  // A component this agent message shows, such as a proposal card, or null for
  // a plain message. The history returns it too, with the proposal's current
  // status, so the card is still there after a refresh.
  ui?: ChatUiEvent | null;
};

export type Conversation = {
  id: string;
  status: string;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessages = Conversation & {
  messages: Message[];
};

export type ChatResult = {
  guestMessage: Message;
  agentMessage: Message;
  warningIssued: boolean;
  warningCount: number;
  conversationStatus: string;
  // The reply again, in the structured form
  message: { role: "assistant"; content: string };
  // A component to show with the reply, or null for a plain message
  ui: ChatUiEvent | null;
};

// Every API response has this shape. Errors from the reservation routes also
// have a code (such as "TABLES_UNAVAILABLE"), and some a kind and data.
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; message: string; code?: string; kind?: string; data?: unknown };

// status is 0 when the request never reached the API.
// code and kind are only set when the API sent them.
export class ApiError extends Error {
  status: number;
  data?: unknown;
  code?: string;
  kind?: string;

  constructor(
    message: string,
    status: number,
    data?: unknown,
    { code, kind }: { code?: string; kind?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.code = code;
    this.kind = kind;
  }
}

// Call the API and return its data, or throw an ApiError
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, options);
  } catch {
    throw new ApiError("Could not reach the API", 0);
  }

  const body = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (!body) {
    // Status 500, so this text is never shown to the guest
    throw new ApiError("The API sent an unreadable response", 500);
  }

  if (!body.success) {
    throw new ApiError(body.message, response.status, body.data, {
      code: typeof body.code === "string" ? body.code : undefined,
      kind: typeof body.kind === "string" ? body.kind : undefined,
    });
  }

  return body.data;
}

export function createConversation() {
  return request<Conversation>("/conversations", { method: "POST" });
}

export function getConversation(conversationId: string) {
  return request<ConversationWithMessages>(
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
}

export function addMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
) {
  return request<Message>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content }),
    },
  );
}

// Saves the guest message and returns it together with Claude's reply
export function sendChatMessage(conversationId: string, content: string) {
  return request<ChatResult>(
    `/conversations/${encodeURIComponent(conversationId)}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

// When Claude fails after the guest message was saved, the error includes that message
export function getSavedGuestMessage(error: unknown): Message | null {
  if (error instanceof ApiError && error.data && typeof error.data === "object") {
    const { guestMessage } = error.data as { guestMessage?: Message };
    return guestMessage ?? null;
  }

  return null;
}

// Some errors say what the conversation is now, such as a 403 for a blocked one
export function getErrorConversationState(
  error: unknown,
): Pick<Conversation, "status" | "warningCount"> | null {
  if (error instanceof ApiError && error.data && typeof error.data === "object") {
    const { conversationStatus, warningCount } = error.data as {
      conversationStatus?: string;
      warningCount?: number;
    };
    if (typeof conversationStatus === "string" && typeof warningCount === "number") {
      return { status: conversationStatus, warningCount };
    }
  }

  return null;
}

// The API's own error message, which it writes to be safe to show a guest.
// Unexpected server errors and network failures get a friendly sentence instead.
export function getApiErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status !== 0 && error.status !== 500) {
    return error.message;
  }

  return getFriendlyErrorMessage(error);
}

// Turn any failed request into a sentence that is safe to show a guest
export function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return "We can't reach Hammad Foods right now. Please check your connection and try again.";
    }
    if (error.status === 404) {
      return "We couldn't find this conversation.";
    }
    if (error.status === 409) {
      return "This conversation has ended, so new messages can't be sent.";
    }
  }

  return "Something went wrong on our side. Please try again.";
}
