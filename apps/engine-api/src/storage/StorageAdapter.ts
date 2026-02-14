export class StorageAdapter {
  constructor(
    private ctx: DurableObjectState, 
    private bucket: R2Bucket
  ) {}

  async saveLog(botId: string, logEntry: any) {
    const timestamp = Date.now();
    const key = `bots/${botId}/logs/${timestamp}.json`;
    
    // Fire-and-forget log writing to R2, ensuring completion via waitUntil
    this.ctx.waitUntil(
      this.bucket.put(key, JSON.stringify(logEntry), {
        customMetadata: { type: "log", botId },
      })
    );
  }

  async saveState(botId: string, state: any) {
    // 1. Fast: Save to DO Storage (local, low latency)
    await this.ctx.storage.put("state", state);

    // 2. Durable: Backup to R2 (async, eventual consistency)
    const key = `bots/${botId}/state.json`;
    // Ensure this background task completes even if the DO goes idle
    this.ctx.waitUntil(
      this.bucket.put(key, JSON.stringify(state))
    ); 
  }

  async loadState(botId: string): Promise<any | null> {
    // Try DO Storage first
    const state = await this.ctx.storage.get("state");
    if (state) return state;

    // Fallback to R2 (e.g., if DO was reset or migrated)
    const key = `bots/${botId}/state.json`;
    const object = await this.bucket.get(key);
    if (object) {
      return await object.json();
    }

    return null;
  }
}
