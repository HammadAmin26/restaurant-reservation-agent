import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { ChatLoading } from "@/components/chat/ChatLoading";
import { ChatWindow } from "@/components/chat/ChatWindow";

export const metadata: Metadata = {
  title: "Your reservation | Hammad Foods",
};

async function Conversation({
  params,
}: Pick<PageProps<"/reserve/[conversationId]">, "params">) {
  const { conversationId } = await params;

  // key resets all chat state when the URL points to another conversation
  return <ChatWindow key={conversationId} conversationId={conversationId} />;
}

export default function ReservePage({
  params,
}: PageProps<"/reserve/[conversationId]">) {
  return (
    <main className="flex h-dvh flex-col">
      <header className="border-b border-line bg-cream">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <BrandLogo />
          <p className="hidden text-sm text-muted sm:block">Table reservations</p>
        </div>
      </header>
      <Suspense fallback={<ChatLoading />}>
        <Conversation params={params} />
      </Suspense>
    </main>
  );
}
