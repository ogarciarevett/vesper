import { useState, useEffect, useCallback } from "react";
import { Plus, Building2, ChevronDown } from "lucide-react";
import { api } from "../lib/api";

const STORAGE_KEY = "openclaw-rooms";

interface RoomSelectorProps {
  currentRoomId: string;
  onRoomChange: (roomId: string) => void;
}

function loadSavedRooms(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      return Array.isArray(parsed) ? parsed : ["main"];
    }
  } catch {
    // ignore
  }
  return ["main"];
}

function saveRooms(rooms: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}

export function RoomSelector({ currentRoomId, onRoomChange }: RoomSelectorProps) {
  const [rooms, setRooms] = useState<string[]>(loadSavedRooms);
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomType, setNewRoomType] = useState<"TRADING" | "PREDICTION_MARKET">("TRADING");
  const [error, setError] = useState<string | null>(null);

  // Ensure current room is in the list
  useEffect(() => {
    if (!rooms.includes(currentRoomId)) {
      const updated = [...rooms, currentRoomId];
      setRooms(updated);
      saveRooms(updated);
    }
  }, [currentRoomId, rooms]);

  const handleCreateRoom = useCallback(async () => {
    if (!newRoomName.trim()) return;
    setError(null);

    try {
      const result = await api.createRoom(newRoomName.trim(), {
        roomType: newRoomType,
      });
      const roomId = (result as { roomId?: string }).roomId ?? newRoomName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

      const updated = [...rooms, roomId];
      setRooms(updated);
      saveRooms(updated);
      setNewRoomName("");
      setIsCreating(false);
      onRoomChange(roomId);
    } catch (err) {
      setError(String(err));
    }
  }, [newRoomName, newRoomType, rooms, onRoomChange]);

  return (
    <div className="relative">
      {/* Current room button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/70 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
      >
        <Building2 size={14} className="text-white/40" />
        <span className="flex-1 text-left truncate">{currentRoomId}</span>
        <ChevronDown size={12} className={`text-white/30 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-[#1a1a22] border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
          {rooms.map((roomId) => (
            <button
              key={roomId}
              type="button"
              onClick={() => {
                onRoomChange(roomId);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2 text-xs text-left hover:bg-white/5 transition-colors ${
                roomId === currentRoomId ? "text-cyan-400 bg-cyan-500/5" : "text-white/60"
              }`}
            >
              {roomId}
            </button>
          ))}

          {/* Create room */}
          {isCreating ? (
            <div className="p-2 border-t border-white/5 space-y-2">
              <input
                type="text"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="Room name..."
                className="w-full px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-white placeholder-white/30 focus:outline-none focus:border-cyan-500/50"
                onKeyDown={(e) => e.key === "Enter" && handleCreateRoom()}
              />
              <select
                value={newRoomType}
                onChange={(e) => setNewRoomType(e.target.value as "TRADING" | "PREDICTION_MARKET")}
                className="w-full px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-white/70 focus:outline-none"
              >
                <option value="TRADING">Trading</option>
                <option value="PREDICTION_MARKET">Prediction Market</option>
              </select>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={handleCreateRoom}
                  className="flex-1 px-2 py-1 text-xs bg-cyan-500/20 text-cyan-300 rounded hover:bg-cyan-500/30"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => { setIsCreating(false); setError(null); }}
                  className="px-2 py-1 text-xs bg-white/5 text-white/40 rounded hover:bg-white/10"
                >
                  Cancel
                </button>
              </div>
              {error && <p className="text-[10px] text-red-400">{error}</p>}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setIsCreating(true); setIsOpen(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/40 hover:text-white/60 hover:bg-white/5 border-t border-white/5"
            >
              <Plus size={12} />
              New Room
            </button>
          )}
        </div>
      )}
    </div>
  );
}
