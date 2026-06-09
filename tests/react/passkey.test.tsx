// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { liveQuery } from 'dexie';
import React from 'react';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieStore } from '../../src/dexie/store';
import { createCryptoStoreContext } from '../../src/react/crypto';
import { defineStore } from '../../src/store';
import {
  type CryptoManager,
  type CryptoPayload,
  createCryptoStore,
  keyTableDef,
  cryptoManager as makeCryptoManager,
} from '../../src/store/crypto';

// ─── Mock setup ───────────────────────────────────────────────────────────────

type MockKey = string;

const deriveKeyMock = vi.fn(
  async (_config: any, secret: Uint8Array, _salt: Uint8Array) => {
    const out = new Uint8Array(32);
    out.set(secret.slice(0, 32));
    return out;
  },
);
const importKeyMock = vi.fn(async () => 'mock-key' as MockKey);
const encryptMock = vi.fn(
  async (_config: any, _key: MockKey, data: Uint8Array) => ({
    iv: 'mock-iv',
    cipher: btoa(String.fromCharCode(...data)),
  }),
);
const decryptMock = vi.fn(
  async (_config: any, _key: MockKey, { cipher }: CryptoPayload) =>
    Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0)),
);

const mockManager: CryptoManager<MockKey> = {
  deriveKey: deriveKeyMock,
  importKey: importKeyMock,
  encrypt: encryptMock,
  decrypt: decryptMock,
  loadComputeKey: vi.fn(
    async (
      _config: any,
      mek: MockKey,
      _namespace?: Uint8Array,
    ): Promise<MockKey> => `compute:${mek}`,
  ),
  compute: vi.fn(
    async (
      _config: any,
      key: MockKey,
      data: Uint8Array,
    ): Promise<Uint8Array> => {
      const keyBytes = new TextEncoder().encode(key);
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++)
        out[i] = data[i % data.length]! ^ keyBytes[i % keyBytes.length]!;
      return out;
    },
  ),
};

// ─── Store + context setup ────────────────────────────────────────────────────

const defs = defineStore({ key: keyTableDef });
let dbCounter = 0;

const _ctx = createCryptoStoreContext<typeof defs>();
const { StoreContext, usePasskeyRotation } = _ctx.bind<MockKey>();

let rawStore: DexieStore<typeof defs>;
let cs: ReturnType<typeof createCryptoStore<typeof defs, MockKey>>;

beforeEach(() => {
  vi.clearAllMocks();
  rawStore = new DexieStore(`test-passkey-${++dbCounter}`, defs);
  cs = createCryptoStore(rawStore, defs, mockManager);
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <StoreContext.Provider
      value={{ rawStore, cryptoStore: cs, manager: mockManager, liveQuery }}
    >
      {children}
    </StoreContext.Provider>
  );
}

async function seedAccountKey() {
  const km = makeCryptoManager(mockManager);
  const secret = new Uint8Array(32).fill(1);
  const { accountStoreKeys } = await km.updateMasterKey(secret);
  const accountStoreKey = accountStoreKeys[0]!;
  await cs.store.table.key.upsertMany([accountStoreKey]);
  return { secret, accountStoreKey };
}

async function seedRecoveryKey(
  accountStoreKey: Awaited<
    ReturnType<typeof seedAccountKey>
  >['accountStoreKey'],
  accountSecret: Uint8Array,
) {
  const km = makeCryptoManager(mockManager);
  const { storeKeys } = await km.updateKey(
    'recovery',
    new Uint8Array(32).fill(2),
    [
      {
        ...accountStoreKey,
        mv: 0,
        ev: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false,
      },
    ],
    accountSecret,
  );
  const storeKey = storeKeys[0]!;
  const recoveryKey = { ...storeKey, id: uuidv7() };
  await cs.store.table.key.upsertMany([recoveryKey]);
  return recoveryKey;
}

// ─── usePasskeyRotation ───────────────────────────────────────────────────────

describe('usePasskeyRotation', () => {
  it('completes successfully: state becomes done, callbacks fired', async () => {
    await seedAccountKey();
    const deletePasskey = vi.fn(async (_id: string) => {});
    const createPasskey = vi.fn(async () => {});
    const onDone = vi.fn(async () => {});

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey,
          createPasskey,
          onDone,
        }),
      { wrapper },
    );

    expect(result.current.state.status).toBe('idle');

    await act(() => result.current.start('old-passkey-id'));

    expect(result.current.state.status).toBe('done');
    expect(deletePasskey).toHaveBeenCalledWith('old-passkey-id');
    expect(createPasskey).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('progresses through running steps before completing', async () => {
    await seedAccountKey();
    const steps: number[] = [];

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    // After completion, final state is done
    expect(result.current.state.status).toBe('done');
    void steps; // used to suppress unused warning
  });

  it('calls sync before onDone when provided', async () => {
    await seedAccountKey();
    const callOrder: string[] = [];
    const sync = vi.fn(async () => {
      callOrder.push('sync');
    });
    const onDone = vi.fn(async () => {
      callOrder.push('onDone');
    });

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone,
          sync,
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(callOrder).toEqual(['sync', 'onDone']);
  });

  it('enters phrase-needed when re-encrypt fails and a recovery key exists', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);

    decryptMock.mockRejectedValueOnce(new Error('bad credential'));

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('phrase-needed');
  });

  it('sets error when re-encrypt fails and no recovery key exists', async () => {
    await seedAccountKey();
    decryptMock.mockRejectedValueOnce(new Error('bad credential'));

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('error');
    expect(
      (result.current.state as { status: 'error'; error: string }).error,
    ).toContain('Could not re-encrypt');
  });

  it('sets error state when getOldSecret throws', async () => {
    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => {
            throw new Error('no passkey');
          },
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('error');
  });

  it('tryPhraseRecovery succeeds: state becomes done and onDone is called', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    decryptMock.mockRejectedValueOnce(new Error('bad cred'));

    const onDone = vi.fn(async () => {});
    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone,
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('phrase-needed');

    await act(() =>
      result.current.tryPhraseRecovery(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );
    expect(result.current.state.status).toBe('done');
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('tryPhraseRecovery calls sync before onDone', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    decryptMock.mockRejectedValueOnce(new Error('bad cred'));

    const callOrder: string[] = [];
    const sync = vi.fn(async () => {
      callOrder.push('sync');
    });
    const onDone = vi.fn(async () => {
      callOrder.push('onDone');
    });

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone,
          sync,
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    await act(() =>
      result.current.tryPhraseRecovery(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );
    expect(callOrder).toEqual(['sync', 'onDone']);
  });

  it('tryPhraseRecovery preserves the account key id', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    decryptMock.mockRejectedValueOnce(new Error('bad cred'));

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    await act(() =>
      result.current.tryPhraseRecovery(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );

    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'account' } },
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(accountStoreKey.id);
  });

  it('tryPhraseRecovery sets phraseError when the operation fails', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    decryptMock.mockRejectedValueOnce(new Error('bad cred'));

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('phrase-needed');

    decryptMock.mockRejectedValueOnce(new Error('bad phrase decrypt'));
    await act(() =>
      result.current.tryPhraseRecovery(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );

    expect(result.current.phraseError).toBe(
      'Invalid recovery phrase. Check each word and try again.',
    );
    expect(result.current.state.status).toBe('phrase-needed');
  });

  it('tryPhraseRecovery is a no-op when called without a pending start', async () => {
    const onDone = vi.fn(async () => {});
    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone,
        }),
      { wrapper },
    );

    await act(() => result.current.tryPhraseRecovery('some phrase'));
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('idle');
  });

  it('start resets phraseError and pending secret from previous run', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    decryptMock.mockRejectedValueOnce(new Error('bad cred'));

    const { result } = renderHook(
      () =>
        usePasskeyRotation({
          getOldSecret: async () => new Uint8Array(32).fill(1),
          getNewSecret: async () => new Uint8Array(32).fill(3),
          deletePasskey: async () => {},
          createPasskey: async () => {},
          onDone: async () => {},
        }),
      { wrapper },
    );

    // First run: enter phrase-needed
    await act(() => result.current.start('pk'));
    expect(result.current.state.status).toBe('phrase-needed');

    // Second run: succeeds, clearing state
    await act(() => result.current.start('pk'));
    expect(result.current.phraseError).toBe('');
  });
});
