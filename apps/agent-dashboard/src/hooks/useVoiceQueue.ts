import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage } from "./useTradingSocket";

const MAX_QUEUE_SIZE = 5;

export interface VoiceQueueState {
  /** Whether voice playback is enabled */
  enabled: boolean;
  /** Current volume (0-1) */
  volume: number;
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Agent ID currently speaking */
  speakingAgentId: string | null;
  /** Number of items in the queue */
  queueSize: number;
}

export function useVoiceQueue(agentMessages: AgentMessage[]) {
  const [enabled, setEnabled] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const queueRef = useRef<AgentMessage[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processingRef = useRef(false);
  const processedIdsRef = useRef<Set<string>>(new Set());

  // Enqueue new messages that have audio URLs
  useEffect(() => {
    if (!enabled) return;
    for (const msg of agentMessages) {
      if (
        msg.messageId &&
        (msg as AgentMessage & { audioUrl?: string }).audioUrl &&
        !processedIdsRef.current.has(msg.messageId)
      ) {
        processedIdsRef.current.add(msg.messageId);
        queueRef.current.push(msg);
        // Drop older items if queue is too large (stay real-time)
        if (queueRef.current.length > MAX_QUEUE_SIZE) {
          queueRef.current = queueRef.current.slice(-MAX_QUEUE_SIZE);
        }
      }
    }
    // Trigger processing
    processQueue();
  }, [agentMessages, enabled]);

  const processQueue = useCallback(() => {
    if (processingRef.current || !enabled) return;
    const next = queueRef.current.shift();
    if (!next) {
      setIsPlaying(false);
      setSpeakingAgentId(null);
      return;
    }

    const audioUrl = (next as AgentMessage & { audioUrl?: string }).audioUrl;
    if (!audioUrl) {
      processQueue();
      return;
    }

    processingRef.current = true;
    setIsPlaying(true);
    setSpeakingAgentId(next.fromAgentId);

    const audio = new Audio(audioUrl);
    audio.volume = volume;
    audioRef.current = audio;

    audio.onended = () => {
      processingRef.current = false;
      setIsPlaying(false);
      setSpeakingAgentId(null);
      audioRef.current = null;
      // Process next item in queue
      processQueue();
    };

    audio.onerror = () => {
      console.error("Voice audio playback failed for:", audioUrl);
      processingRef.current = false;
      setIsPlaying(false);
      setSpeakingAgentId(null);
      audioRef.current = null;
      processQueue();
    };

    audio.play().catch(() => {
      // Autoplay might be blocked
      processingRef.current = false;
      setIsPlaying(false);
      setSpeakingAgentId(null);
    });
  }, [enabled, volume]);

  // Update volume on playing audio
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      if (prev && audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
        processingRef.current = false;
        setIsPlaying(false);
        setSpeakingAgentId(null);
        queueRef.current = [];
      }
      return !prev;
    });
  }, []);

  const state: VoiceQueueState = {
    enabled,
    volume,
    isPlaying,
    speakingAgentId,
    queueSize: queueRef.current.length,
  };

  return {
    ...state,
    toggleEnabled,
    setVolume,
  };
}
