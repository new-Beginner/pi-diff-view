/** Incremental UTF-8 accounting; unchanged values retain identity across feed refreshes. */
export class JsonCache<K, V> extends Map<K, V> {
  private encoded = new Map<K, { json: string; bytes: number }>();
  byteSize = 0;
  override set(key: K, value: V): this {
    const json = JSON.stringify(value), previous = this.encoded.get(key);
    const stable = previous?.json === json ? this.get(key)! : value;
    const bytes = previous?.json === json ? previous.bytes : new TextEncoder().encode(json).length;
    this.byteSize += bytes - (previous?.bytes ?? 0);
    super.delete(key); super.set(key, stable);
    this.encoded.set(key, { json, bytes });
    return this;
  }
  override delete(key: K): boolean {
    this.byteSize -= this.encoded.get(key)?.bytes ?? 0;
    this.encoded.delete(key);
    return super.delete(key);
  }
  override clear(): void { super.clear(); this.encoded.clear(); this.byteSize = 0; }
}
