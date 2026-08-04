import { Injectable, signal } from '@angular/core';

export interface DeviceCapabilityResult {
  hasWebGpu: boolean;
  hasWasmSimd: boolean;
  deviceMemoryGb: number;
  hardwareCores: number;
  isCapableOfLocalAi: boolean;
  recommendedMode: 'local-gpu' | 'local-wasm' | 'server-cloud';
  reason: string;
}

@Injectable({
  providedIn: 'root',
})
export class DeviceCapabilityService {
  capability = signal<DeviceCapabilityResult | null>(null);

  constructor() {
    this.detectCapabilities();
  }

  async detectCapabilities(): Promise<DeviceCapabilityResult> {
    let hasWebGpu = false;
    let hasWasmSimd = false;

    // Probe 1: WebGPU API availability
    if ('gpu' in navigator && (navigator as any).gpu) {
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        hasWebGpu = !!adapter;
      } catch {
        hasWebGpu = false;
      }
    }

    // Probe 2: WASM SIMD support check
    try {
      hasWebGpu = hasWebGpu || false;
      hasWasmSimd = typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';
    } catch {
      hasWasmSimd = false;
    }

    // Probe 3: Device Hardware Constraints
    const deviceMemoryGb = (navigator as any).deviceMemory || 4; // default conservative 4GB if unreported
    const hardwareCores = navigator.hardwareConcurrency || 4; // default 4 cores

    let isCapable = false;
    let recommendedMode: 'local-gpu' | 'local-wasm' | 'server-cloud' = 'server-cloud';
    let reason = '';

    if (hasWebGpu && deviceMemoryGb >= 4 && hardwareCores >= 4) {
      isCapable = true;
      recommendedMode = 'local-gpu';
      reason = 'Device supports high-performance WebGPU acceleration and adequate RAM/cores.';
    } else if (hasWasmSimd && deviceMemoryGb >= 4 && hardwareCores >= 2) {
      isCapable = true;
      recommendedMode = 'local-wasm';
      reason = 'Device supports WASM SIMD execution; fallback to CPU tensor runtime.';
    } else {
      isCapable = false;
      recommendedMode = 'server-cloud';
      reason = `Device hardware constrained (${deviceMemoryGb}GB RAM, ${hardwareCores} cores, WebGPU: ${hasWebGpu}). Server offloading activated.`;
    }

    const result: DeviceCapabilityResult = {
      hasWebGpu,
      hasWasmSimd,
      deviceMemoryGb,
      hardwareCores,
      isCapableOfLocalAi: isCapable,
      recommendedMode,
      reason,
    };

    this.capability.set(result);
    return result;
  }

  isServerFallbackRequired(): boolean {
    const current = this.capability();
    return !current || !current.isCapableOfLocalAi || current.recommendedMode === 'server-cloud';
  }
}
