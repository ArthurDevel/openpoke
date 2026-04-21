interface ChatHeaderProps {
  mode: 'chat' | 'talk';
  onModeChange: (mode: 'chat' | 'talk') => void;
  onOpenSettings: () => void;
  onClearHistory: () => void;
}

export function ChatHeader({ mode, onModeChange, onOpenSettings, onClearHistory }: ChatHeaderProps) {
  return (
    <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">OpenPoke 🌴</h1>
        <div className="inline-flex rounded-full border border-gray-200 bg-white p-1 shadow-sm">
          <button
            className={`rounded-full px-3 py-1.5 text-sm transition ${mode === 'chat' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            onClick={() => onModeChange('chat')}
          >
            Chat
          </button>
          <button
            className={`rounded-full px-3 py-1.5 text-sm transition ${mode === 'talk' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            onClick={() => onModeChange('talk')}
          >
            Talk
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
          onClick={onOpenSettings}
        >
          Settings
        </button>
        <button
          className="rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
          onClick={onClearHistory}
        >
          Clear
        </button>
      </div>
    </header>
  );
}
