/** A Task input that passes every Check. VK is the real mainnet vk_hash (larger than the field modulus). */
export const VALID_RAW_INPUT = {
  registered_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  proof_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  minimum: '1000',
  public_balance: '1460',
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: '0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01',
  condition_recipient: '0xde42a1b2c3d4e5f60718293a4b5c6d7e8f909f01',
  amount: '500',
  max_transfer: '1000',
  proof_tx: '0xa4c1aa00000000000000000000000000000000000000000000000000000008ff1',
};

export type RawInput = typeof VALID_RAW_INPUT;

export function rawInput(over: Partial<Record<keyof RawInput, unknown>> = {}): Record<string, unknown> {
  return { ...VALID_RAW_INPUT, ...over };
}

export function envelope(taskId: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input,
    ...extra,
  };
}
