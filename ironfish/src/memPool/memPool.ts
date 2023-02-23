/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BufferMap } from 'buffer-map'
import { Assert } from '../assert'
import { Blockchain } from '../blockchain'
import { Consensus, isExpiredSequence } from '../consensus'
import { createRootLogger, Logger } from '../logger'
import { MetricsMonitor } from '../metrics'
import { getTransactionSize } from '../network/utils/serializers'
import { Block, BlockHeader } from '../primitives'
import { Transaction, TransactionHash } from '../primitives/transaction'
import { FeeEstimator, getFeeRate } from './feeEstimator'
import { PriorityQueue } from './priorityQueue'
import { RecentlyEvictedCache } from './recentlyEvictedCache'

interface MempoolEntry {
  hash: TransactionHash
  feeRate: bigint
}

interface ExpirationMempoolEntry {
  expiration: number
  hash: TransactionHash
}

export function mempoolEntryComparator(
  firstTransaction: MempoolEntry,
  secondTransaction: MempoolEntry,
): boolean {
  if (firstTransaction.feeRate !== secondTransaction.feeRate) {
    return firstTransaction.feeRate > secondTransaction.feeRate
  }

  return firstTransaction.hash.compare(secondTransaction.hash) > 0
}

export class MemPool {
  private readonly transactions = new BufferMap<Transaction>()

  private readonly nullifiers = new BufferMap<Buffer>()

  private readonly feeRateQueue: PriorityQueue<MempoolEntry>
  private readonly evictionQueue: PriorityQueue<MempoolEntry>
  private readonly expirationQueue: PriorityQueue<ExpirationMempoolEntry>

  private readonly recentlyEvictedCache: RecentlyEvictedCache

  /* Keep track of number of bytes stored in the transaction map */
  private transactionsBytes = 0
  private readonly maxSizeBytes: number
  private readonly consensus: Consensus

  head: BlockHeader | null

  private readonly chain: Blockchain
  private readonly logger: Logger
  private readonly metrics: MetricsMonitor

  readonly feeEstimator: FeeEstimator

  constructor(options: {
    chain: Blockchain
    consensus: Consensus
    feeEstimator: FeeEstimator
    metrics: MetricsMonitor
    maxSizeBytes: number
    recentlyEvictedCacheSize: number
    logger?: Logger
  }) {
    const logger = options.logger || createRootLogger()

    this.maxSizeBytes = options.maxSizeBytes
    this.consensus = options.consensus
    this.head = null

    this.feeRateQueue = new PriorityQueue<MempoolEntry>(mempoolEntryComparator, (t) =>
      t.hash.toString('hex'),
    )

    this.evictionQueue = new PriorityQueue<MempoolEntry>(
      (e1, e2) => !mempoolEntryComparator(e1, e2),
      (t) => t.hash.toString('hex'),
    )

    this.expirationQueue = new PriorityQueue<ExpirationMempoolEntry>(
      (t1, t2) => t1.expiration < t2.expiration,
      (t) => t.hash.toString('hex'),
    )

    this.chain = options.chain
    this.logger = logger.withTag('mempool')
    this.metrics = options.metrics

    this.feeEstimator = options.feeEstimator

    this.chain.onConnectBlock.on((block) => {
      this.feeEstimator.onConnectBlock(block, this)
      this.onConnectBlock(block)
    })

    this.chain.onDisconnectBlock.on(async (block) => {
      this.feeEstimator.onDisconnectBlock(block)
      await this.onDisconnectBlock(block)
    })

    this.recentlyEvictedCache = new RecentlyEvictedCache({
      logger: this.logger,
      capacity: options.recentlyEvictedCacheSize,
    })
  }

  async start(): Promise<void> {
    await this.feeEstimator.init(this.chain)
  }

  count(): number {
    return this.transactions.size
  }

  /**
   * @return The number of bytes stored in the mempool
   */
  sizeBytes(): number {
    return this.transactionsBytes
  }

  exists(hash: TransactionHash): boolean {
    return this.transactions.has(hash)
  }

  /*
   * Returns a transaction if the transaction with that hash exists in the mempool
   * Otherwise, returns undefined
   */
  get(hash: TransactionHash): Transaction | undefined {
    return this.transactions.get(hash)
  }

  *orderedTransactions(): Generator<Transaction, void, unknown> {
    const clone = this.feeRateQueue.clone()

    while (clone.size() > 0) {
      const feeAndHash = clone.poll()

      Assert.isNotUndefined(feeAndHash)
      const transaction = this.transactions.get(feeAndHash.hash)

      // The queue is cloned above, but this.transactions is not, so the
      // transaction may be removed from this.transactions while iterating.
      if (transaction === undefined) {
        continue
      }

      yield transaction
    }
  }

  /**
   * Accepts a transaction from the network.
   * This does not guarantee that the transaction will be added to the mempool.
   *
   * @returns true if the transaction was added to the mempool
   */
  acceptTransaction(transaction: Transaction): boolean {
    const hash = transaction.hash().toString('hex')
    const sequence = transaction.expiration()
    if (this.exists(transaction.hash())) {
      return false
    }

    if (isExpiredSequence(sequence, this.chain.head.sequence)) {
      this.logger.debug(`Invalid transaction '${hash}': expired sequence ${sequence}`)
      return false
    }

    const added = this.addTransaction(transaction)

    if (!added) {
      return false
    }

    this.logger.debug(`Accepted tx ${hash}, poolsize ${this.count()}`)
    return true
  }

  onConnectBlock(block: Block): void {
    let deletedTransactions = 0

    for (const transaction of block.transactions) {
      const didDelete = this.deleteTransaction(transaction)
      if (didDelete) {
        deletedTransactions++
      }
    }

    let nextExpired = this.expirationQueue.peek()
    while (nextExpired && isExpiredSequence(nextExpired.expiration, this.chain.head.sequence)) {
      const transaction = this.get(nextExpired.hash)
      if (!transaction) {
        continue
      }

      const didDelete = this.deleteTransaction(transaction)
      if (didDelete) {
        deletedTransactions++
      }

      nextExpired = this.expirationQueue.peek()
    }

    if (deletedTransactions) {
      this.logger.debug(`Deleted ${deletedTransactions} transactions`)
    }
    this.head = block.header
    this.recentlyEvictedCache.flush(this.head.sequence)
  }

  async onDisconnectBlock(block: Block): Promise<void> {
    let addedTransactions = 0

    for (const transaction of block.transactions) {
      if (transaction.isMinersFee()) {
        continue
      }

      const added = this.addTransaction(transaction)
      if (added) {
        addedTransactions++
      }
    }

    this.logger.debug(`Added ${addedTransactions} transactions`)

    this.head = await this.chain.getHeader(block.header.previousBlockHash)
  }

  /**
   * Add a new transaction to the mempool. If the mempool is full, the lowest feeRate transactions
   * are evicted from the mempool.
   *
   * Transactions with duplicate nullifers are rejected.
   *
   * @param transaction the transaction to add
   *
   * @returns true if the transaction was added, false if it was rejected
   */
  private addTransaction(transaction: Transaction): boolean {
    const hash = transaction.hash()

    if (this.transactions.has(hash)) {
      return false
    }

    // Don't allow transactions with duplicate nullifiers
    // TODO(daniel): Don't delete transactions if we aren't going to add the transaction anyway
    for (const spend of transaction.spends) {
      const existingHash = this.nullifiers.get(spend.nullifier)
      const existingTransaction = existingHash && this.transactions.get(existingHash)

      if (existingTransaction) {
        if (transaction.fee() > existingTransaction.fee()) {
          this.deleteTransaction(existingTransaction)
        } else {
          return false
        }
      }
    }

    this.transactions.set(hash, transaction)

    for (const spend of transaction.spends) {
      this.nullifiers.set(spend.nullifier, hash)
    }

    this.feeRateQueue.add({ hash, feeRate: getFeeRate(transaction) })
    this.evictionQueue.add({ hash, feeRate: getFeeRate(transaction) })
    this.expirationQueue.add({ hash, expiration: transaction.expiration() })

    this.transactionsBytes += getTransactionSize(transaction)
    this.metrics.memPoolSize.value = this.count()

    // TODO: Add telemetry for evictions
    if (this.full()) {
      this.evictTransactions()
    }

    return this.transactions.has(hash)
  }

  /**
   * @returns true if the mempool is over capacity
   */
  full(): boolean {
    return this.sizeBytes() >= this.maxSizeBytes
  }

  /**
   * @returns true if a transaction hash is in the recently evicted cache
   */
  recentlyEvicted(hash: TransactionHash): boolean {
    return this.recentlyEvictedCache.has(hash.toString('hex'))
  }

  /**
   * Evicts transactions from the mempool until it is under capacity.
   * Transactions are evicted in order of fee rate (descending).
   *
   * @returns an array of the evicted transactions
   */
  private evictTransactions(): Transaction[] {
    const evictedTransactions: Transaction[] = []

    while (this.full()) {
      const next = this.evictionQueue.peek()

      const transaction = next && this.transactions.get(next.hash)
      // If mempool is full, we should always have a transaction
      Assert.isNotUndefined(transaction)

      this.deleteTransaction(transaction)

      // Transactions are added with a max lifespan of the current mempool size in blocks.
      // This is because the evicted transaction has a lower fee rate than every transaction
      // currently in the mempool.
      this.recentlyEvictedCache.add(
        transaction.hash(),
        getFeeRate(transaction),
        this.chain.head.sequence,
        this.sizeInBlocks(),
      )

      evictedTransactions.push(transaction)
    }

    return evictedTransactions
  }

  /**
   * @returns the current size of the mempool in blocks
   */
  sizeInBlocks(): number {
    return Math.floor(this.sizeBytes() / this.consensus.parameters.maxBlockSizeBytes)
  }

  private deleteTransaction(transaction: Transaction): boolean {
    const hash = transaction.hash()
    const deleted = this.transactions.delete(hash)

    if (!deleted) {
      return false
    }

    this.transactionsBytes -= getTransactionSize(transaction)

    for (const spend of transaction.spends) {
      this.nullifiers.delete(spend.nullifier)
    }

    const hashAsString = hash.toString('hex')

    this.feeRateQueue.remove(hashAsString)
    this.evictionQueue.remove(hashAsString)
    this.expirationQueue.remove(hashAsString)

    this.metrics.memPoolSize.value = this.count()
    return true
  }
}
