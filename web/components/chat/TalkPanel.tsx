'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

interface TalkPanelProps {
  onError: (message: string | null) => void;
}

type LiveKitTokenPayload = {
  room_name: string;
  participant_identity: string;
  participant_token: string;
  server_url: string;
};

export function TalkPanel({ onError }: TalkPanelProps) {
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioCountRef = useRef(0);

  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [hasRemoteAudio, setHasRemoteAudio] = useState(false);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('Join Talk to start a LiveKit voice conversation.');

  const syncRemoteAudioState = useCallback(() => {
    setHasRemoteAudio(remoteAudioCountRef.current > 0);
  }, []);

  const disconnectRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;

    if (room) {
      room.disconnect();
    }

    remoteAudioCountRef.current = 0;
    syncRemoteAudioState();
    setIsConnected(false);
    setIsMuted(false);
    setIsConnecting(false);
    setRoomName(null);
  }, [syncRemoteAudioState]);

  const connectRoom = useCallback(async () => {
    if (roomRef.current || isConnecting) {
      return;
    }

    setIsConnecting(true);
    onError(null);
    setStatusText('Fetching LiveKit token…');

    try {
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload?.detail ||
          payload?.error ||
          `LiveKit request failed (${response.status})`;
        throw new Error(message);
      }

      const tokenPayload = payload as LiveKitTokenPayload;
      const room = new Room();

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio || !audioContainerRef.current) {
          return;
        }

        const element = track.attach();
        element.autoplay = true;
        audioContainerRef.current.appendChild(element);
        remoteAudioCountRef.current += 1;
        syncRemoteAudioState();
        setStatusText('Connected. The voice agent is live.');
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) {
          return;
        }

        track.detach().forEach((element) => element.remove());
        remoteAudioCountRef.current = Math.max(0, remoteAudioCountRef.current - 1);
        syncRemoteAudioState();
        setStatusText('Connected. Waiting for the voice agent audio stream.');
      });

      room.on(RoomEvent.Disconnected, () => {
        remoteAudioCountRef.current = 0;
        syncRemoteAudioState();
        setIsConnected(false);
        setIsMuted(false);
        setRoomName(null);
        setStatusText('Talk disconnected.');
      });

      await room.connect(tokenPayload.server_url, tokenPayload.participant_token);
      await room.localParticipant.setMicrophoneEnabled(true);

      roomRef.current = room;
      setIsConnected(true);
      setIsMuted(false);
      setRoomName(tokenPayload.room_name);
      setStatusText(`Joined ${tokenPayload.room_name}. Start speaking naturally.`);
    } catch (error: any) {
      const message = error?.message || 'Failed to connect to LiveKit';
      onError(message);
      setStatusText(message);
      disconnectRoom();
    } finally {
      setIsConnecting(false);
    }
  }, [disconnectRoom, isConnecting, onError, syncRemoteAudioState]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) {
      return;
    }

    const nextMuted = !isMuted;
    await room.localParticipant.setMicrophoneEnabled(!nextMuted);
    setIsMuted(nextMuted);
    setStatusText(nextMuted ? 'Microphone muted.' : 'Microphone unmuted.');
  }, [isMuted]);

  useEffect(() => {
    return () => {
      disconnectRoom();
    };
  }, [disconnectRoom]);

  return (
    <section className="flex min-h-[560px] flex-col items-center justify-center px-6 py-10 text-center">
      <div className="w-full max-w-xl rounded-[28px] border border-gray-200 bg-gradient-to-b from-white to-gray-50 p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-brand-600">Talk Mode</p>
        <h2 className="mt-3 text-3xl font-semibold text-gray-900">Realtime voice with shared transcript.</h2>
        <p className="mt-3 text-sm text-gray-600">{statusText}</p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <span className="chip">{isConnected ? 'Room connected' : isConnecting ? 'Connecting' : 'Disconnected'}</span>
          <span className="chip">{hasRemoteAudio ? 'Agent audio active' : 'Waiting for agent audio'}</span>
          <span className="chip">{roomName ? roomName : 'No room joined'}</span>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button className="btn min-w-[160px]" onClick={() => void (isConnected ? disconnectRoom() : connectRoom())}>
            {isConnected ? 'Leave talk' : isConnecting ? 'Joining…' : 'Join talk'}
          </button>
          <button
            className="rounded-full border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void toggleMute()}
            disabled={!isConnected}
          >
            {isMuted ? 'Unmute mic' : 'Mute mic'}
          </button>
        </div>

        <div className="mt-8 rounded-3xl border border-dashed border-gray-300 bg-white/80 px-5 py-6 text-left">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">How It Works</p>
          <p className="mt-3 text-sm text-gray-700">
            Talk mode now uses a LiveKit voice agent instead of browser speech APIs. Your microphone audio goes to the
            agent, the agent handles STT and turn-taking, then replies with streamed voice.
          </p>
        </div>
      </div>

      <div ref={audioContainerRef} className="hidden" />
    </section>
  );
}
