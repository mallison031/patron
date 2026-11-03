'use client';

import './buffer-shim';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';

import { DEMO_MODE, NETWORK } from './config';

import type { PatronTransaction } from './api';

type Transaction = PatronTransaction;

interface WalletState {
  accountId: string | null;
  connecting: boolean;
  busy: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  /** One or more transactions signed as one user gesture: the backer's storage registration and
   *  their `ft_transfer_call` ship together, so funding is a single click. */
  submit: (transactions: Transaction[]) => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside <WalletProvider>');
  return value;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<ReturnType<typeof setupModal> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    setupWalletSelector({
      network: NETWORK,
      modules: [setupMeteorWallet()],
    })
      .then((next) => {
        if (cancelled) return;
        setSelector(next);
        modalRef.current = setupModal(next, { contractId: '' });
        const accounts = next.store.getState().accounts;
        if (accounts.length) setAccountId(accounts[0].accountId);
        const first = (list: Array<{ accountId: string }>) =>
          setAccountId(list.length ? list[0].accountId : null);
        const subscriptions = [
          next.on('signedIn', (event) => first(event.accounts)),
          next.on('signedOut', () => setAccountId(null)),
          next.on('accountsChanged', (event) => first(event.accounts)),
        ];
        unsubscribeRef.current = () => subscriptions.forEach((sub) => sub.remove());
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
    };
  }, []);

  const connect = useCallback(() => {
    setConnecting(true);
    setError(null);
    try {
      modalRef.current?.show();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (!selector) return;
    void selector
      .wallet()
      .then((wallet) => wallet.signOut())
      .catch(() => undefined);
    setAccountId(null);
  }, [selector]);

  const submit = useCallback(
    async (transactions: Transaction[]) => {
      if (!selector || !accountId) {
        setError('connect a wallet first');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const wallet = await selector.wallet();
        const outcomes = await wallet.signAndSendTransactions({ transactions });
        // Some wallets resolve without reporting outcomes; a rejected or failed receipt is the
        // only on-chain signal we get, so surface it instead of showing a false success.
        if (Array.isArray(outcomes)) {
          const failed = outcomes.find((outcome) =>
            typeof outcome.status === 'object'
              ? 'Failure' in outcome.status
              : outcome.status === 'Failure',
          );
          if (failed) throw new Error(JSON.stringify(failed.status));
        }
      } catch (cause) {
        const message =
          cause && typeof cause === 'object' && 'message' in cause
            ? String((cause as { message: unknown }).message)
            : String(cause);
        setError(message);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [selector, accountId],
  );

  const value = useMemo(
    () => ({ accountId, connecting, busy, error, connect, disconnect, submit }),
    [accountId, connecting, busy, error, connect, disconnect, submit],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
