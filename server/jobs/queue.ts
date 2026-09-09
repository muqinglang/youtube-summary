import { randomUUID } from 'node:crypto';
import type { AiRequest, AiResult, JobProgress } from '../../src/shared/types';
import type { Gateway } from '../ai/gateway';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  type: 'progress' | 'done' | 'error';
  progress?: Omit<JobProgress, 'jobId'>;
  result?: AiResult;
  error?: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  progress?: Omit<JobProgress, 'jobId'>;
  result?: AiResult;
  error?: string;
}

interface Job extends JobView {
  userId: string;
  controller: AbortController;
  finishedAt?: number;
  listeners: Set<(event: JobEvent) => void>;
}

export interface QueueOptions {
  /** Long jobs are dozens of provider calls; more than a few at once just invites rate limits. */
  concurrency?: number;
  /** Finished jobs stay readable for a while so a reconnecting client can still collect them. */
  retentionMs?: number;
  maxPerUser?: number;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private readonly concurrency: number;
  private readonly retentionMs: number;
  private readonly maxPerUser: number;

  constructor(
    private readonly gateway: Gateway,
    options: QueueOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 3;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxPerUser = options.maxPerUser ?? 2;
  }

  runningFor(userId: string): number {
    let count = 0;
    for (const job of this.jobs.values())
      if (job.userId === userId && job.status === 'running') count += 1;
    return count;
  }

  start(userId: string, request: AiRequest): Job {
    this.sweep();
    if (this.runningFor(userId) >= this.maxPerUser)
      throw new Error('已有任务在处理，请等待完成或取消后再试。');
    const job: Job = {
      id: randomUUID(),
      userId,
      status: 'running',
      controller: new AbortController(),
      listeners: new Set(),
    };
    this.jobs.set(job.id, job);
    void this.execute(job, request);
    return job;
  }

  private async execute(job: Job, request: AiRequest): Promise<void> {
    await this.acquire();
    try {
      if (job.controller.signal.aborted) return;
      const { result } = await this.gateway.run(
        request,
        (progress) => {
          job.progress = progress;
          this.emit(job, { type: 'progress', progress });
        },
        job.controller.signal,
      );
      job.status = 'done';
      job.result = result;
      this.emit(job, { type: 'done', result });
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.status = 'cancelled';
        job.error = '任务已取消。';
      } else {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : '处理失败，请重试。';
      }
      this.emit(job, { type: 'error', error: job.error });
    } finally {
      job.finishedAt = Date.now();
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private emit(job: Job, event: JobEvent): void {
    for (const listener of job.listeners) listener(event);
    if (event.type !== 'progress') job.listeners.clear();
  }

  view(id: string, userId: string): JobView | undefined {
    const job = this.jobs.get(id);
    // Job ids are unguessable, but ownership is still checked rather than assumed.
    if (!job || job.userId !== userId) return undefined;
    const { id: jobId, status, progress, result, error } = job;
    return { id: jobId, status, progress, result, error };
  }

  subscribe(
    id: string,
    userId: string,
    listener: (event: JobEvent) => void,
  ): (() => void) | undefined {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) return undefined;
    if (job.status !== 'running') {
      listener(
        job.status === 'done'
          ? { type: 'done', result: job.result }
          : { type: 'error', error: job.error ?? '任务已结束。' },
      );
      return () => undefined;
    }
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  cancel(id: string, userId: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId || job.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  /** Lets a shutdown wait for work the user already paid for, up to a deadline. */
  async drain(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let running = 0;
      for (const job of this.jobs.values()) if (job.status === 'running') running += 1;
      if (running === 0) return 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let abandoned = 0;
    for (const job of this.jobs.values())
      if (job.status === 'running') {
        job.controller.abort();
        abandoned += 1;
      }
    return abandoned;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs)
      if (job.finishedAt !== undefined && job.finishedAt < cutoff) this.jobs.delete(id);
  }
}
