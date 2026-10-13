export class DeviceLockManager {
  private readonly lockedDevices = new Map<string, string>();

  constructor(private readonly enabled: boolean) {}

  async withLock<T>(deviceId: string, action: string, callback: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return callback();
    }
    const existing = this.lockedDevices.get(deviceId);
    if (existing) {
      throw new Error(`设备 ${deviceId} 正在执行 ${existing}`);
    }
    this.lockedDevices.set(deviceId, action);
    try {
      return await callback();
    } finally {
      this.lockedDevices.delete(deviceId);
    }
  }
}
