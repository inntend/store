import { mnemonicToSeed } from '@scure/bip39';
import { useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { AnyTableDef } from '../store';
import type { EncryptedStore } from '../store/crypto';
import type { CryptoContextBase } from './crypto';

export type RotationPhase =
  | { status: 'idle' }
  | { status: 'running'; stepIndex: number }
  | { status: 'phrase-needed' }
  | { status: 'done' }
  | { status: 'error'; error: string };

async function findPasskeyKeys<TDefs extends Record<string, AnyTableDef>>(
  store: EncryptedStore<TDefs, any>,
  type: 'account' | 'recovery',
) {
  return store.table.key.findMany({ where: { type: { $eq: type } } });
}

async function findPasskeyKey<TDefs extends Record<string, AnyTableDef>>(
  store: EncryptedStore<TDefs, any>,
  type: 'account' | 'recovery',
) {
  return (
    await store.table.key.findMany({
      where: { type: { $eq: type } },
      orderBy: { ev: 'desc', createdAt: 'desc' },
      limit: 1,
    })
  )?.[0];
}

export function createPasskeyHooks<TDefs extends Record<string, AnyTableDef>>(
  useStoreContext: () => CryptoContextBase<TDefs, any>,
) {
  function usePasskeyRotation(options: {
    getOldSecret: () => Promise<Uint8Array>;
    getNewSecret: () => Promise<Uint8Array>;
    deletePasskey: (id: string) => Promise<void>;
    createPasskey: () => Promise<void>;
    onDone: () => Promise<void>;
    sync?: () => Promise<void>;
  }): {
    state: RotationPhase;
    start: (passkeyId: string) => Promise<void>;
    startLost: (passkeyId: string, phrase: string) => Promise<void>;
    tryPhraseRecovery: (phrase: string) => Promise<void>;
    phraseError: string;
  } {
    const { store, keyManager } = useStoreContext();
    const [state, setState] = useState<RotationPhase>({ status: 'idle' });
    const [phraseError, setPhraseError] = useState('');
    const pendingNewSecret = useRef<Uint8Array | undefined>(undefined);

    async function reEncryptAccount(
      newSecret: Uint8Array,
      oldSecret: Uint8Array,
    ) {
      const accountKeys = await findPasskeyKeys(store, 'account');
      const { storeKeys } = await keyManager.updateKey(
        'account',
        newSecret,
        accountKeys.length > 0 ? accountKeys : undefined,
        oldSecret,
      );
      await store.table.key.upsertMany(storeKeys);
    }

    async function start(passkeyId: string) {
      pendingNewSecret.current?.fill(0);
      pendingNewSecret.current = undefined;
      setPhraseError('');
      setState({ status: 'running', stepIndex: 0 });

      let oldSecret: Uint8Array | undefined;
      let newSecret: Uint8Array | undefined;
      let copy: Uint8Array | undefined;
      try {
        oldSecret = await options.getOldSecret();

        setState({ status: 'running', stepIndex: 1 });
        await options.deletePasskey(passkeyId);
        await options.createPasskey();

        setState({ status: 'running', stepIndex: 2 });
        newSecret = await options.getNewSecret();

        setState({ status: 'running', stepIndex: 3 });
        copy = newSecret.slice();

        let encryptFailed = false;
        try {
          await reEncryptAccount(newSecret, oldSecret);
        } catch {
          encryptFailed = true;
        }

        if (encryptFailed) {
          const recoveryKey = await findPasskeyKey(store, 'recovery');
          if (!recoveryKey)
            throw new Error(
              'Could not re-encrypt with the new passkey and no recovery phrase is configured.',
            );
          pendingNewSecret.current = copy;
          copy = undefined;
          setState({ status: 'phrase-needed' });
          return;
        }

        copy.fill(0);
        copy = undefined;
        await options.sync?.();
        await options.onDone();
        setState({ status: 'done' });
      } catch (err) {
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : 'Something went wrong.',
        });
      } finally {
        oldSecret?.fill(0);
        newSecret?.fill(0);
        copy?.fill(0);
      }
    }

    async function startLost(passkeyId: string, phrase: string) {
      pendingNewSecret.current?.fill(0);
      pendingNewSecret.current = undefined;
      setPhraseError('');
      setState({ status: 'running', stepIndex: 0 });

      let phraseSeed: Uint8Array | undefined;
      let newSecret: Uint8Array | undefined;
      try {
        phraseSeed = await mnemonicToSeed(phrase.trim());
        const recoveryKeys = await findPasskeyKeys(store, 'recovery');
        if (recoveryKeys.length === 0)
          throw new Error('No recovery phrase is configured for this account.');

        setState({ status: 'running', stepIndex: 1 });
        await options.deletePasskey(passkeyId);
        await options.createPasskey();

        setState({ status: 'running', stepIndex: 2 });
        newSecret = await options.getNewSecret();

        setState({ status: 'running', stepIndex: 3 });
        const accountKey = await findPasskeyKey(store, 'account');
        const { storeKeys } = await keyManager.updateKey(
          'account',
          newSecret,
          recoveryKeys,
          phraseSeed,
        );
        await store.table.key.upsertMany(
          storeKeys.map((sk: any, i: number) => ({
            ...sk,
            id: i === 0 ? (accountKey?.id ?? uuidv7()) : uuidv7(),
          })),
        );

        await options.sync?.();
        await options.onDone();
        setState({ status: 'done' });
      } catch (err) {
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : 'Something went wrong.',
        });
      } finally {
        phraseSeed?.fill(0);
        newSecret?.fill(0);
      }
    }

    async function tryPhraseRecovery(phrase: string) {
      const newSecret = pendingNewSecret.current;
      if (!newSecret) return;

      setPhraseError('');
      let phraseSeed: Uint8Array | undefined;
      try {
        phraseSeed = await mnemonicToSeed(phrase.trim());
        const recoveryKeys = await findPasskeyKeys(store, 'recovery');
        if (recoveryKeys.length === 0)
          throw new Error('Recovery key not found.');
        const accountKey = await findPasskeyKey(store, 'account');
        const { storeKeys } = await keyManager.updateKey(
          'account',
          newSecret,
          recoveryKeys,
          phraseSeed,
        );
        await store.table.key.upsertMany(
          storeKeys.map((sk: any, i: number) => ({
            ...sk,
            id: i === 0 ? (accountKey?.id ?? uuidv7()) : uuidv7(),
          })),
        );
        await options.sync?.();

        pendingNewSecret.current?.fill(0);
        pendingNewSecret.current = undefined;
        await options.onDone();
        setState({ status: 'done' });
      } catch {
        setPhraseError(
          'Invalid recovery phrase. Check each word and try again.',
        );
      } finally {
        phraseSeed?.fill(0);
      }
    }

    return { state, start, startLost, tryPhraseRecovery, phraseError };
  }

  return { usePasskeyRotation };
}
