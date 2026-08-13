"use client";

import { ArrowUpIcon, BotIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentWelcome } from "@/components/workspace/agent-welcome";
import { getBackendBaseURL } from "@/core/config";
import { cn } from "@/lib/utils";

import { LocalAgentGuideQuestions } from "./local-agent-guide-questions";

interface PublicAgentInfo {
  name: string;
  public_name: string;
  description: string;
  tool_groups: string[] | null;
  skills: string[] | null;
  guide_questions?: Array<{ question: string; prompt?: string }>;
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

  async function sendMessage(guidePrompt?: string) {
    const message = (guidePrompt ?? draft).trim();
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

  const isWelcomeMode = messages.length === 0;

  return (
    <main className="bg-background relative flex min-h-screen flex-col overflow-hidden">
      <header
        className={cn(
          "absolute top-0 right-0 left-0 z-30 flex h-12 items-center gap-2 px-2 sm:px-4",
          isWelcomeMode
            ? "bg-background/0"
            : "bg-background/80 shadow-xs backdrop-blur",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1">
          <BotIcon className="text-primary size-3.5" />
          <span className="max-w-64 truncate text-xs font-medium">
            {agent.name}
          </span>
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col pt-12">
        {!isWelcomeMode && (
          <div className="mx-auto flex min-h-0 w-full max-w-(--container-width-md) flex-1 flex-col overflow-y-auto px-4 pt-6 pb-8">
            <div className="space-y-5">
              {messages.map((item, index) => (
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
                      ? "bg-muted max-w-[85%] rounded-2xl px-4 py-2.5 text-sm"
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
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        )}

        <div
          className={cn(
            "right-0 bottom-0 left-0 z-30 flex justify-center px-3 sm:px-4",
            isWelcomeMode ? "absolute" : "relative shrink-0 pb-4",
          )}
        >
          <div
            className={cn(
              "relative w-full",
              isWelcomeMode &&
                "-translate-y-[calc(50vh-48px)] sm:-translate-y-[calc(50vh-96px)]",
              isWelcomeMode
                ? "max-w-(--container-width-sm)"
                : "max-w-(--container-width-md)",
            )}
          >
            {isWelcomeMode && (
              <AgentWelcome
                className="absolute right-0 bottom-full left-0"
                agent={{
                  name: agent.name,
                  description: agent.description,
                  model: null,
                  tool_groups: agent.tool_groups,
                  skills: null,
                }}
                agentName={agent.name}
              />
            )}
            {error && (
              <p className="text-destructive mb-2 px-3 text-xs">{error}</p>
            )}
            <div className="bg-background/85 border-input/50 relative z-10 rounded-2xl border shadow-xs backdrop-blur-sm">
              <Textarea
                value={draft}
                rows={1}
                maxLength={20_000}
                autoFocus={isWelcomeMode}
                placeholder="发送消息"
                className="max-h-48 min-h-16 resize-none rounded-2xl border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <div className="flex min-h-11 items-center justify-end px-3 pb-2">
                <Button
                  size="icon"
                  variant="outline"
                  className="rounded-full"
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
            {isWelcomeMode && (
              <LocalAgentGuideQuestions
                className="absolute top-full right-0 left-0"
                questions={agent.guide_questions ?? []}
                disabled={sending}
                onSelect={setDraft}
              />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
