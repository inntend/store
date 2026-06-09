// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
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

const loadComputeKeyMock = vi.fn(
  async (
    _config: any,
    mek: MockKey,
    _namespace?: Uint8Array,
  ): Promise<MockKey> => `compute:${mek}`,
);
const computeMock = vi.fn(
  async (_config: any, key: MockKey, data: Uint8Array): Promise<Uint8Array> => {
    const keyBytes = new TextEncoder().encode(key);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      out[i] = data[i % data.length]! ^ keyBytes[i % keyBytes.length]!;
    return out;
  },
);

const mockManager: CryptoManager<MockKey> = {
  deriveKey: deriveKeyMock,
  importKey: importKeyMock,
  encrypt: encryptMock,
  decrypt: decryptMock,
  loadComputeKey: loadComputeKeyMock,
  compute: computeMock,
};

// ─── Store + context setup ────────────────────────────────────────────────────

const defs = defineStore({ key: keyTableDef });
let dbCounter = 0;

const _ctx = createCryptoStoreContext<typeof defs>();
const { useHasMek, useComputeIndex, useForceReencrypt } = _ctx;
const {
  StoreContext,
  useMek,
  useEncryption,
  useEncryptionSetup,
  useRecoveryPhrase,
  useRecoveryStatus,
  useKeyManagement,
  useReencryption,
} = _ctx.bind<MockKey>();

let rawStore: DexieStore<typeof defs>;
let cs: ReturnType<typeof createCryptoStore<typeof defs, MockKey>>;

beforeEach(() => {
  vi.clearAllMocks();
  rawStore = new DexieStore(`test-crypto-${++dbCounter}`, defs);
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
  await cs.store.table.key.insertMany([accountStoreKey]);
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

// ─── useMek ───────────────────────────────────────────────────────────────────

describe('useMek', () => {
  it('mek is undefined initially', () => {
    const { result } = renderHook(() => useMek(), { wrapper });
    expect(result.current.mek).toBeUndefined();
  });

  it('setMek updates mek', async () => {
    const { result } = renderHook(() => useMek(), { wrapper });
    await act(() => {
      result.current.setMek('new-key');
    });
    expect(result.current.mek).toBe('new-key');
  });

  it('clearMek resets mek to undefined', async () => {
    const { result } = renderHook(() => useMek(), { wrapper });
    await act(() => {
      result.current.setMek('new-key');
    });
    await act(() => {
      result.current.clearMek();
    });
    expect(result.current.mek).toBeUndefined();
  });
});

// ─── useHasMek ────────────────────────────────────────────────────────────────

describe('useHasMek', () => {
  it('false when no mek is loaded', () => {
    const { result } = renderHook(() => useHasMek(), { wrapper });
    expect(result.current).toBe(false);
  });

  it('true after mek is loaded', async () => {
    const { result } = renderHook(
      () => ({ hasMek: useHasMek(), mek: useMek() }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('test-key');
    });
    expect(result.current.hasMek).toBe(true);
  });
});

// ─── useEncryption — updateMasterKey ─────────────────────────────────────────

describe('useEncryption — updateMasterKey', () => {
  it('stores an account key and sets the mek', async () => {
    const { result } = renderHook(
      () => ({ enc: useEncryption(), mek: useMek() }),
      { wrapper },
    );
    await act(() =>
      result.current.enc.updateMasterKey(new Uint8Array(32).fill(1)),
    );

    expect(result.current.mek.mek).toBeDefined();
    const keys = await cs.store.table.key.findMany();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.type).toBe('account');
  });

  it('deletes any existing recovery keys', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    expect(await cs.store.table.key.findMany()).toHaveLength(2);

    const { result } = renderHook(() => useEncryption(), { wrapper });
    await act(() => result.current.updateMasterKey(secret));

    const recoveryKeys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'recovery' } },
    });
    expect(recoveryKeys).toHaveLength(0);
  });

  it('preserves the existing key id when rotating via oldType + oldSecret', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    const originalId = accountStoreKey.id;

    const { result } = renderHook(() => useEncryption(), { wrapper });
    await act(() =>
      result.current.updateMasterKey(
        new Uint8Array(32).fill(2),
        'account',
        secret,
      ),
    );

    const keys = await cs.store.table.key.findMany();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(originalId);
  });
});

// ─── useEncryption — updatePassword ──────────────────────────────────────────

describe('useEncryption — updatePassword', () => {
  it('creates an account key when none exists', async () => {
    const { result } = renderHook(() => useEncryption(), { wrapper });
    await act(() => result.current.updatePassword(new Uint8Array(32).fill(1)));

    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'account' } },
    });
    expect(keys).toHaveLength(1);
  });

  it('preserves the key id when rotating', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();

    const { result } = renderHook(() => useEncryption(), { wrapper });
    await act(() =>
      result.current.updatePassword(new Uint8Array(32).fill(2), secret),
    );

    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'account' } },
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(accountStoreKey.id);
  });
});

// ─── useEncryption — updatePhrase ────────────────────────────────────────────

describe('useEncryption — updatePhrase', () => {
  it('creates a recovery key and returns a 12-word mnemonic', async () => {
    await seedAccountKey();

    const { result } = renderHook(() => useEncryption(), { wrapper });
    let phrase!: string;
    await act(async () => {
      phrase = await result.current.updatePhrase();
    });

    expect(phrase.split(' ')).toHaveLength(12);
    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'recovery' } },
    });
    expect(keys).toHaveLength(1);
  });
});

// ─── useEncryption — loadKey ──────────────────────────────────────────────────

describe('useEncryption — loadKey', () => {
  it('loads an account key and sets the mek', async () => {
    const { secret } = await seedAccountKey();

    const { result } = renderHook(
      () => ({ enc: useEncryption(), mek: useMek() }),
      { wrapper },
    );
    await act(() => result.current.enc.loadKey('account', secret));

    expect(result.current.mek.mek).toBe('mock-key');
  });
});

// ─── useEncryptionSetup ───────────────────────────────────────────────────────

describe('useEncryptionSetup', () => {
  const pullKeys = vi.fn(async () => {});

  it('creates master key and calls onSuccess on first launch', async () => {
    const onSuccess = vi.fn();
    renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => new Uint8Array(32).fill(1),
          pullKeys,
          onSuccess,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    const keys = await cs.store.table.key.findMany();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.type).toBe('account');
  });

  it('loads existing account key and calls onSuccess', async () => {
    const { secret } = await seedAccountKey();
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () => ({
        setup: useEncryptionSetup({
          getSecret: async () => secret,
          pullKeys,
          onSuccess,
        }),
        hasMek: useHasMek(),
      }),
      { wrapper },
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(result.current.hasMek).toBe(true);
  });

  it('sets phase to failed when getSecret throws and no recovery key exists', async () => {
    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => {
            throw new Error('no cred');
          },
          pullKeys,
          onSuccess: vi.fn(),
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('failed'));
  });

  it('sets phase to recovery when getSecret throws and a recovery key exists', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);

    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => {
            throw new Error('no cred');
          },
          pullKeys,
          onSuccess: vi.fn(),
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('recovery'));
  });

  it('falls back when loadKey fails', async () => {
    await seedAccountKey();
    decryptMock.mockRejectedValueOnce(new Error('bad decrypt'));

    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => new Uint8Array(32).fill(1),
          pullKeys,
          onSuccess: vi.fn(),
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('failed'));
  });

  it('tryRecovery loads the recovery key and calls onSuccess', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => {
            throw new Error('no cred');
          },
          pullKeys,
          onSuccess,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('recovery'));
    await act(() =>
      result.current.tryRecovery(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('tryRecovery sets error and throws when loadKey fails', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    await seedRecoveryKey(accountStoreKey, secret);

    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => {
            throw new Error('no cred');
          },
          pullKeys,
          onSuccess: vi.fn(),
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('recovery'));

    decryptMock.mockRejectedValueOnce(new Error('bad decrypt'));
    let caught = false;
    await act(async () => {
      try {
        await result.current.tryRecovery(
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        );
      } catch {
        caught = true;
      }
    });
    expect(caught).toBe(true);
    await waitFor(() =>
      expect(result.current.error).toBe(
        'Invalid recovery phrase. Check each word and try again.',
      ),
    );
  });
});

// ─── useRecoveryPhrase ────────────────────────────────────────────────────────

describe('useRecoveryPhrase', () => {
  const secret = new Uint8Array(32).fill(1);

  it('generate creates a recovery key and sets phrase', async () => {
    await seedAccountKey();

    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret }),
      { wrapper },
    );

    await act(() => result.current.generate());
    await waitFor(() => expect(result.current.phrase).not.toBe(''));

    expect(result.current.phrase.split(' ')).toHaveLength(12);
    expect(result.current.error).toBe('');
    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'recovery' } },
    });
    expect(keys).toHaveLength(1);
  });

  it('generating is false after completion', async () => {
    await seedAccountKey();
    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret }),
      { wrapper },
    );

    await act(() => result.current.generate());
    expect(result.current.generating).toBe(false);
  });

  it('sets error when no account key exists', async () => {
    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret }),
      { wrapper },
    );

    await act(() => result.current.generate());

    expect(result.current.error).toBe('No account key found.');
    expect(result.current.phrase).toBe('');
  });

  it('calls sync after generating', async () => {
    await seedAccountKey();
    const sync = vi.fn(async () => {});
    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret, sync }),
      { wrapper },
    );

    await act(() => result.current.generate());
    expect(sync).toHaveBeenCalledOnce();
  });

  it('clearPhrase resets phrase to empty string', async () => {
    await seedAccountKey();
    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret }),
      { wrapper },
    );

    await act(() => result.current.generate());
    expect(result.current.phrase).toBeTruthy();
    await act(() => {
      result.current.clearPhrase();
    });
    expect(result.current.phrase).toBe('');
  });

  it('preserves existing recovery key id on regenerate', async () => {
    const { accountStoreKey } = await seedAccountKey();
    const existingRecovery = await seedRecoveryKey(accountStoreKey, secret);

    const { result } = renderHook(
      () => useRecoveryPhrase({ getSecret: async () => secret }),
      { wrapper },
    );

    await act(() => result.current.generate());

    const keys = await cs.store.table.key.findMany({
      where: { type: { $eq: 'recovery' } },
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(existingRecovery.id);
  });
});

// ─── useRecoveryStatus ────────────────────────────────────────────────────────

describe('useRecoveryStatus', () => {
  it('loading is true before first emission', () => {
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@example.com' }),
      { wrapper },
    );
    expect(result.current.loading).toBe(true);
  });

  it('hasPhrase is false when no recovery key exists', async () => {
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@example.com' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasPhrase).toBe(false);
  });

  it('hasPhrase becomes true when a recovery key is inserted', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@example.com' }),
      { wrapper },
    );

    await act(async () => {
      await seedRecoveryKey(accountStoreKey, secret);
    });

    await waitFor(() => expect(result.current.hasPhrase).toBe(true));
  });

  it('hasEmail is true for a valid email', () => {
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@example.com' }),
      { wrapper },
    );
    expect(result.current.hasEmail).toBe(true);
  });

  it('hasEmail is false for a @passkey.invalid address', () => {
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@passkey.invalid' }),
      { wrapper },
    );
    expect(result.current.hasEmail).toBe(false);
  });

  it('hasEmail is false when email is undefined', () => {
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: undefined }),
      { wrapper },
    );
    expect(result.current.hasEmail).toBe(false);
  });

  it('isComplete when both email and phrase are present', async () => {
    const { secret, accountStoreKey } = await seedAccountKey();
    const { result } = renderHook(
      () => useRecoveryStatus({ userEmail: 'user@example.com' }),
      { wrapper },
    );

    await act(async () => {
      await seedRecoveryKey(accountStoreKey, secret);
    });

    await waitFor(() => expect(result.current.isComplete).toBe(true));
  });
});

// ─── useKeyManagement ─────────────────────────────────────────────────────────

describe('useKeyManagement', () => {
  it('returns the keyManager with expected methods', () => {
    const { result } = renderHook(() => useKeyManagement(), { wrapper });
    expect(typeof result.current.updateKey).toBe('function');
    expect(typeof result.current.loadKey).toBe('function');
    expect(typeof result.current.updateMasterKey).toBe('function');
  });
});

// ─── useEncryption — loadKey error ───────────────────────────────────────────

describe('useEncryption — loadKey error', () => {
  it('throws when no key of the specified type exists', async () => {
    const { result } = renderHook(() => useEncryption(), { wrapper });

    let caughtError: Error | undefined;
    await act(async () => {
      try {
        await result.current.loadKey('account', new Uint8Array(32).fill(1));
      } catch (e) {
        caughtError = e as Error;
      }
    });

    expect(caughtError?.message).toMatch(/No account key found/);
  });
});

// ─── useEncryptionSetup — getCachedKey ────────────────────────────────────────

describe('useEncryptionSetup — getCachedKey', () => {
  const pullKeys = vi.fn(async () => {});

  it('uses a cached key and calls onSuccess without pulling', async () => {
    const onSuccess = vi.fn();
    const getCachedKey = vi.fn(async (): Promise<MockKey> => 'cached-key');

    const { result } = renderHook(
      () => ({
        setup: useEncryptionSetup({
          getSecret: async () => new Uint8Array(32).fill(1),
          pullKeys,
          onSuccess,
          getCachedKey,
        }),
        hasMek: useHasMek(),
      }),
      { wrapper },
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(result.current.hasMek).toBe(true);
    expect(getCachedKey).toHaveBeenCalledOnce();
    expect(pullKeys).not.toHaveBeenCalled();
  });

  it('falls back to normal setup when getCachedKey returns undefined', async () => {
    const onSuccess = vi.fn();
    const getCachedKey = vi.fn(
      async (): Promise<MockKey | undefined> => undefined,
    );

    renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => new Uint8Array(32).fill(1),
          pullKeys,
          onSuccess,
          getCachedKey,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(pullKeys).toHaveBeenCalledOnce();
  });

  it('sets error via outer catch when getCachedKey throws', async () => {
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useEncryptionSetup({
          getSecret: async () => new Uint8Array(32).fill(1),
          pullKeys: async () => {},
          onSuccess,
          getCachedKey: async () => {
            throw new Error('cache error');
          },
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBe('cache error'));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

// ─── useForceReencrypt ────────────────────────────────────────────────────────

describe('useForceReencrypt', () => {
  it('calls forceReencrypt and bumps version when mek is set and version is newer', async () => {
    vi.spyOn(cs, 'forceReencrypt').mockResolvedValue(undefined);

    const { result } = renderHook(
      () => {
        const mek = useMek();
        useForceReencrypt(1);
        return mek;
      },
      { wrapper },
    );

    await act(() => {
      result.current.setMek('mock-key');
    });

    await waitFor(() => expect(cs.forceReencrypt).toHaveBeenCalledOnce());
    const stored = await (rawStore.settings as any).get('reencryptVersion');
    expect(stored).toBe(1);
  });

  it('does not call forceReencrypt when hasMek is false', async () => {
    vi.spyOn(cs, 'forceReencrypt').mockResolvedValue(undefined);

    renderHook(() => useForceReencrypt(1), { wrapper });

    await act(async () => {});
    expect(cs.forceReencrypt).not.toHaveBeenCalled();
  });

  it('does not call forceReencrypt when stored version is already current', async () => {
    vi.spyOn(cs, 'forceReencrypt').mockResolvedValue(undefined);
    await (rawStore.settings as any).set('reencryptVersion', 2);

    const { result } = renderHook(
      () => {
        const mek = useMek();
        useForceReencrypt(1);
        return mek;
      },
      { wrapper },
    );

    await act(() => {
      result.current.setMek('mock-key');
    });
    await act(async () => {});

    expect(cs.forceReencrypt).not.toHaveBeenCalled();
  });
});

// ─── useReencryption ─────────────────────────────────────────────────────────

describe('useReencryption', () => {
  it('returns undefined when no mek is loaded', () => {
    const { result } = renderHook(() => useReencryption(), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('returns an object with reencrypt function when mek is loaded', async () => {
    const { result } = renderHook(
      () => ({ reenc: useReencryption(), mek: useMek() }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });
    expect(result.current.reenc).toBeDefined();
    expect(typeof result.current.reenc!.reencrypt).toBe('function');
  });

  it('calling reencrypt delegates to cs.reencrypt', async () => {
    vi.spyOn(cs, 'reencrypt').mockResolvedValue(undefined);

    const { result } = renderHook(
      () => ({ reenc: useReencryption(), mek: useMek() }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });

    await act(async () => {
      await result.current.reenc!.reencrypt('old-key');
    });

    expect(cs.reencrypt).toHaveBeenCalledWith('old-key', undefined);
  });
});

// ─── useComputeIndex ──────────────────────────────────────────────────────────

describe('useComputeIndex', () => {
  it('returns undefined when no mek is loaded', () => {
    const { result } = renderHook(() => useComputeIndex(), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('returns a function when mek is loaded', async () => {
    const { result } = renderHook(
      () => ({ compute: useComputeIndex(), mek: useMek() }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });
    expect(typeof result.current.compute).toBe('function');
  });

  it('produces a consistent base64 hash for the same input', async () => {
    const { result } = renderHook(
      () => ({ compute: useComputeIndex(), mek: useMek() }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });

    let h1!: string;
    let h2!: string;
    await act(async () => {
      h1 = await result.current.compute!('hello');
      h2 = await result.current.compute!('hello');
    });
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
  });

  it('accepts a namespace parameter and returns a string hash', async () => {
    const { result } = renderHook(
      () => ({
        c1: useComputeIndex('ns1'),
        c2: useComputeIndex('ns2'),
        mek: useMek(),
      }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });

    let h1!: string;
    let h2!: string;
    await act(async () => {
      h1 = await result.current.c1!('hello');
      h2 = await result.current.c2!('hello');
    });
    expect(typeof h1).toBe('string');
    expect(typeof h2).toBe('string');
  });

  it('clearComputeKeyCache empties the cache', async () => {
    const { result } = renderHook(
      () => ({
        ctx: _ctx.useStoreContext(),
        compute: useComputeIndex('cache-test'),
        mek: useMek(),
      }),
      { wrapper },
    );
    await act(() => {
      result.current.mek.setMek('mock-key');
    });

    await act(async () => {
      await result.current.compute!('data');
    });
    expect(result.current.ctx.computeKeyCache.size).toBeGreaterThan(0);

    await act(() => {
      result.current.ctx.clearComputeKeyCache();
    });
    expect(result.current.ctx.computeKeyCache.size).toBe(0);
  });
});

// ─── useStore / useRawStore ───────────────────────────────────────────────────

describe('useStore and useRawStore', () => {
  it('useStore returns the encrypted store proxy', () => {
    const { result } = renderHook(() => _ctx.useStore(), { wrapper });
    expect(result.current).toBeDefined();
    expect(typeof result.current.table).toBe('object');
  });

  it('useRawStore returns the underlying raw store', () => {
    const { result } = renderHook(() => _ctx.useRawStore(), { wrapper });
    expect(result.current).toBe(rawStore);
  });
});

// ─── buildHooks lambdas via useSync ──────────────────────────────────────────

describe('useSync via _ctx covers buildHooks getStore and getCheckAndFix lambdas', () => {
  it('renders without error and invokes the getStore and getCheckAndFix lambdas', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { key: [] }, hasMore: false });
    const { result } = renderHook(
      () =>
        _ctx.useSync({
          store: {
            key: {
              findMany: vi.fn().mockResolvedValue([]),
              upsertMany: vi.fn().mockResolvedValue([]),
            },
          } as any,
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).toHaveBeenCalled();
  });
});

// ─── useForceReencrypt — error and cleanup paths ──────────────────────────────

describe('useForceReencrypt — error and cleanup coverage', () => {
  it('swallows errors thrown by forceReencrypt (covers catch handler)', async () => {
    vi.spyOn(cs, 'forceReencrypt').mockRejectedValue(
      new Error('reencrypt failed'),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(
      () => {
        const mek = useMek();
        useForceReencrypt(1);
        return mek;
      },
      { wrapper },
    );
    await act(() => {
      result.current.setMek('mock-key');
    });
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledOnce());
    expect(consoleSpy).toHaveBeenCalledWith(
      '[forceReencrypt] error:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('cleanup sets cancelled=true when hasMek cleared after effect fired', async () => {
    vi.spyOn(cs, 'forceReencrypt').mockResolvedValue(undefined);
    const { result, unmount } = renderHook(
      () => {
        const mek = useMek();
        useForceReencrypt(1);
        return mek;
      },
      { wrapper },
    );
    await act(() => {
      result.current.setMek('mock-key');
    });
    await waitFor(() => expect(cs.forceReencrypt).toHaveBeenCalledOnce());
    // Unmounting while hasMek=true triggers the effect cleanup (cancelled = true)
    unmount();
  });
});
