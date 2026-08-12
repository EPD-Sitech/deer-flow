"use client";

import { ArrowUpIcon, BotIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getBackendBaseURL } from "@/core/config";

interface PublicAgentInfo {
  name: string;
  public_name: string;
  description: string;
  tool_groups: string[] | null;
  skills: string[] | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function PublicLocalAgentPage({ publicName }: { publicName: string }) {
  const [agent, setAgent] = useState<PublicAgentInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void globalThis
      .fetch(
        `${getBackendBaseURL()}/api/public/agents/${encodeURIComponent(publicName)}`,
      )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "公开链接不存在或已停用"
              : "智能体加载失败",
          );
        return response.json() as Promise<PublicAgentInfo>;
      })
      .then((result) => {
        if (active) setAgent(result);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [publicName]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    const message = draft.trim();
    if (!message || sending) return;
    const history = messages;
    setMessages((current) => [
      ...current,
      { role: "user", content: message },
      { role: "assistant", content: "" },
    ]);
    setDraft("");
    setSending(true);
    setError(null);

    try {
      const response = await globalThis.fetch(
        `${getBackendBaseURL()}/api/public/agents/${encodeURIComponent(publicName)}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history }),
        },
      );
      if (!response.ok || !response.body) throw new Error("消息发送失败");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event
            .split("\n")
            .find((item) => item.startsWith("data: "));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6)) as {
            type: string;
            content?: string;
            detail?: string;
          };
          if (payload.type === "token" && payload.content) {
            setMessages((current) => {
              const next = [...current];
              const last = next.at(-1);
              if (last?.role === "assistant")
                next[next.length - 1] = {
                  ...last,
                  content: last.content + payload.content,
                };
              return next;
            });
          } else if (payload.type === "error") {
            throw new Error(payload.detail ?? "智能体回复失败");
          }
        }
        if (done) break;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setMessages((current) =>
        current.filter(
          (item, index) => item.content || index !== current.length - 1,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <main className="bg-background flex min-h-screen items-center justify-center">
        <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  }

  if (!agent) {
    return (
      <main className="bg-background flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <BotIcon className="text-muted-foreground size-12" />
        <h1 className="text-xl font-semibold">{error ?? "公开链接不可用"}</h1>
      </main>
    );
  }

  const tags = [...(agent.tool_groups ?? []), ...(agent.skills ?? [])].slice(
    0,
    5,
  );

  return (
    <main className="bg-background flex min-h-screen flex-col">
      <header className="bg-card border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            <BotIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
            <p className="text-muted-foreground truncate text-xs">
              {agent.description || "智能体公开对话"}
            </p>
          </div>
          <span className="text-muted-foreground hidden text-xs sm:block">
            DeerFlow
          </span>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 sm:px-6">
        <div className="flex-1 space-y-5 overflow-y-auto py-6">
          {messages.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center text-center">
              <div className="flex size-16 items-center justify-center rounded-full border bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                <BotIcon className="size-8" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">{agent.name}</h2>
              <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
                {agent.description || "请输入你的问题开始对话。"}
              </p>
              {tags.length > 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="bg-muted rounded-md px-2 py-1 text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((item, index) => (
              <div
                key={`${item.role}-${index}`}
                className={
                  item.role === "user"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                <div
                  className={
                    item.role === "user"
                      ? "max-w-[85%] rounded-lg bg-sky-600 px-4 py-2.5 text-sm text-white"
                      : "max-w-[90%] text-sm leading-7"
                  }
                >
                  {item.role === "assistant" ? (
                    item.content ? (
                      <ClipboardSafeStreamdown>
                        {item.content}
                      </ClipboardSafeStreamdown>
                    ) : (
                      <Loader2Icon className="text-muted-foreground mt-1 size-4 animate-spin" />
                    )
                  ) : (
                    item.content
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="bg-background sticky bottom-0 border-t py-4">
          {error && <p className="text-destructive mb-2 text-xs">{error}</p>}
          <div className="bg-card flex items-end gap-2 rounded-lg border p-2 shadow-sm">
            <Textarea
              value={draft}
              rows={1}
              maxLength={20_000}
              placeholder="发送消息"
              className="max-h-36 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <Button
              size="icon"
              title="发送"
              disabled={sending || !draft.trim()}
              onClick={() => void sendMessage()}
            >
              {sending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <ArrowUpIcon className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
