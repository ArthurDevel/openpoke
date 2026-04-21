'use client';

import { useCallback, useEffect, useState } from 'react';
import SettingsModal, { useSettings } from '@/components/SettingsModal';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { TalkPanel } from '@/components/chat/TalkPanel';
import { useAutoScroll } from '@/components/chat/useAutoScroll';
import type { ChatBubble } from '@/components/chat/types';

const POLL_INTERVAL_MS = 1500;
const ASSISTANT_POLL_ATTEMPTS = 30;
const ASSISTANT_POLL_DELAY_MS = 1000;

type InteractionMode = 'chat' | 'talk';

const formatEscapeCharacters = (text: string): string => {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
};

const isRenderableMessage = (entry: any) =>
  typeof entry?.role === 'string' &&
  typeof entry?.content === 'string' &&
  entry.content.trim().length > 0;

const toBubbles = (payload: any): ChatBubble[] => {
  if (!Array.isArray(payload?.messages)) return [];

  return payload.messages
    .filter(isRenderableMessage)
    .map((message: any, index: number) => ({
      id: `history-${index}`,
      role: message.role,
      text: formatEscapeCharacters(message.content),
    }));
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export default function Page() {
  const { settings, setSettings } = useSettings();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InteractionMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const { scrollContainerRef, handleScroll } = useAutoScroll({
    items: messages,
    isWaiting: isWaitingForResponse,
  });
  const openSettings = useCallback(() => setOpen(true), [setOpen]);
  const closeSettings = useCallback(() => setOpen(false), [setOpen]);

  const fetchHistory = useCallback(async () => {
    const res = await fetch('/api/chat/history', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to load chat history (${res.status})`);
    }
    return res.json();
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const data = await fetchHistory();
      setMessages(toBubbles(data));
      return data;
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      console.error('Failed to load chat history', err);
      return null;
    }
  }, [fetchHistory]);

  const waitForAssistantResponse = useCallback(
    async (baselineCount: number) => {
      for (let attempt = 0; attempt < ASSISTANT_POLL_ATTEMPTS; attempt += 1) {
        await sleep(ASSISTANT_POLL_DELAY_MS);

        try {
          const data = await fetchHistory();
          const currentMessages = toBubbles(data);
          setMessages(currentMessages);

          const newMessages = currentMessages.slice(baselineCount);
          const assistantReply = [...newMessages].reverse().find((message) => message.role === 'assistant');
          if (assistantReply) {
            return assistantReply.text;
          }
        } catch (err) {
          console.error('Error polling for response:', err);
        }
      }

      await loadHistory();
      return null;
    },
    [fetchHistory, loadHistory],
  );

  const sendMessage = useCallback(
    async (text: string, options?: { optimistic?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed) return null;

      const optimistic = options?.optimistic ?? true;
      setError(null);
      setIsWaitingForResponse(true);

      let baselineCount = messages.length;
      let userMessage: ChatBubble | null = null;

      try {
        const historyPayload = await fetchHistory().catch(() => null);
        if (historyPayload) {
          baselineCount = toBubbles(historyPayload).length;
        }

        if (optimistic) {
          userMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            text: formatEscapeCharacters(trimmed),
          };
          setMessages((prev) => [...prev, userMessage as ChatBubble]);
        }

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: trimmed }],
          }),
        });

        if (!(res.ok || res.status === 202)) {
          const detail = await res.text();
          throw new Error(detail || `Request failed (${res.status})`);
        }

        return await waitForAssistantResponse(baselineCount);
      } catch (err: any) {
        console.error('Failed to send message', err);
        setError(err?.message || 'Failed to send message');
        if (userMessage) {
          setMessages((prev) => prev.filter((message) => message.id !== userMessage?.id));
        }
        throw err instanceof Error ? err : new Error('Failed to send message');
      } finally {
        setIsWaitingForResponse(false);
      }
    },
    [fetchHistory, messages.length, waitForAssistantResponse],
  );

  const clearError = useCallback(() => setError(null), [setError]);
  const handleModeChange = useCallback((nextMode: InteractionMode) => {
    clearError();
    setMode(nextMode);
    if (nextMode === 'chat') {
      void loadHistory();
    }
  }, [clearError, loadHistory]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Detect and store browser timezone on first load
  useEffect(() => {
    const detectAndStoreTimezone = async () => {
      // Only run if timezone not already stored
      if (settings.timezone) return;
      
      try {
        const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        
        // Send to server
        const response = await fetch('/api/timezone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timezone: browserTimezone }),
        });
        
        if (response.ok) {
          // Update local settings
          setSettings({ ...settings, timezone: browserTimezone });
        }
      } catch (error) {
        // Fail silently - timezone detection is not critical
        console.debug('Timezone detection failed:', error);
      }
    };

    void detectAndStoreTimezone();
  }, [settings, setSettings]);


  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadHistory();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [loadHistory]);

  const canSubmit = input.trim().length > 0;
  const inputPlaceholder = 'Type a message…';

  const handleClearHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/history', { method: 'DELETE' });
      if (!res.ok) {
        console.error('Failed to clear chat history', res.statusText);
        return;
      }
      setMessages([]);
    } catch (err) {
      console.error('Failed to clear chat history', err);
    }
  }, [setMessages]);

  const triggerClearHistory = useCallback(() => {
    void handleClearHistory();
  }, [handleClearHistory]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const value = input;
    setInput('');
    try {
      await sendMessage(value, { optimistic: true });
    } catch {
      setInput(value);
    }
  }, [canSubmit, input, sendMessage, setInput]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, [setInput]);

  return (
    <main className="chat-bg min-h-screen p-4 sm:p-6">
      <div className="chat-wrap flex flex-col">
        <ChatHeader
          mode={mode}
          onModeChange={handleModeChange}
          onOpenSettings={openSettings}
          onClearHistory={triggerClearHistory}
        />

        <div className="card flex-1 overflow-hidden">
          {mode === 'chat' ? (
            <>
              <ChatMessages
                messages={messages}
                isWaitingForResponse={isWaitingForResponse}
                scrollContainerRef={scrollContainerRef}
                onScroll={handleScroll}
              />

              <div className="border-t border-gray-200 p-3">
                {error && <ErrorBanner message={error} onDismiss={clearError} />}

                <ChatInput
                  value={input}
                  canSubmit={canSubmit}
                  placeholder={inputPlaceholder}
                  onChange={handleInputChange}
                  onSubmit={handleSubmit}
                />
              </div>
            </>
          ) : (
            <>
              {error && (
                <div className="px-3 pt-3">
                  <ErrorBanner message={error} onDismiss={clearError} />
                </div>
              )}
              <TalkPanel onError={setError} />
              <div className="border-t border-gray-200 bg-white">
                <div className="flex items-center justify-between px-4 pt-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Transcript</p>
                    <p className="mt-1 text-sm text-gray-600">Talk uses the same conversation log as chat.</p>
                  </div>
                </div>
                <ChatMessages
                  messages={messages}
                  isWaitingForResponse={false}
                  scrollContainerRef={scrollContainerRef}
                  onScroll={handleScroll}
                  className="h-[34vh] border-t border-transparent"
                />
              </div>
            </>
          )}
        </div>

        <SettingsModal open={open} onClose={closeSettings} settings={settings} onSave={setSettings} />
      </div>
    </main>
  );
}
