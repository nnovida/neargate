import type { Metadata } from 'next';
import { ActivityFeed } from '@/components/activity-feed';

export const metadata: Metadata = {
  title: 'Activity',
  description: 'Live on-chain feed of registrations, payments and attestations.',
};

export default function ActivityPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="microlabel text-accent">on-chain telemetry</p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Activity
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-mut">
        A unified live feed of everything AgentGate writes to the chain — service registrations,
        CSPR payments and reputation attestations. Polled every 5 seconds.
      </p>
      <div className="mt-10">
        <ActivityFeed />
      </div>
    </div>
  );
}
