/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as yup from 'yup'
import { TransactionStatus, TransactionType } from '../../../wallet'
import { ApiNamespace, router } from '../router'
import {
  getAssetBalanceDeltas,
  RpcAccountDecryptedNote,
  serializeRpcAccountTransaction,
} from './types'
import { getAccount, getAccountDecryptedNotes } from './utils'

export type GetAccountTransactionRequest = {
  hash: string
  account?: string
  confirmations?: number
}

export type GetAccountTransactionResponse = {
  account: string
  transaction: {
    hash: string
    status: TransactionStatus
    type: TransactionType
    fee: string
    blockHash?: string
    blockSequence?: number
    notesCount: number
    spendsCount: number
    mintsCount: number
    burnsCount: number
    timestamp: number
    notes: RpcAccountDecryptedNote[]
    assetBalanceDeltas: Array<{ assetId: string; assetName: string; delta: string }>
  } | null
}

export const GetAccountTransactionRequestSchema: yup.ObjectSchema<GetAccountTransactionRequest> =
  yup
    .object({
      account: yup.string(),
      hash: yup.string().defined(),
      confirmations: yup.string(),
    })
    .defined()

export const GetAccountTransactionResponseSchema: yup.ObjectSchema<GetAccountTransactionResponse> =
  yup
    .object({
      account: yup.string().defined(),
      transaction: yup
        .object({
          hash: yup.string().required(),
          status: yup.string().oneOf(Object.values(TransactionStatus)).defined(),
          type: yup.string().oneOf(Object.values(TransactionType)).defined(),
          fee: yup.string().defined(),
          blockHash: yup.string().optional(),
          blockSequence: yup.number().optional(),
          notesCount: yup.number().defined(),
          spendsCount: yup.number().defined(),
          mintsCount: yup.number().defined(),
          burnsCount: yup.number().defined(),
          timestamp: yup.number().defined(),
          notes: yup
            .array(
              yup
                .object({
                  isOwner: yup.boolean().defined(),
                  owner: yup.string().defined(),
                  value: yup.string().defined(),
                  assetId: yup.string().defined(),
                  assetName: yup.string().defined(),
                  sender: yup.string().defined(),
                  memo: yup.string().trim().defined(),
                  spent: yup.boolean(),
                })
                .defined(),
            )
            .defined(),
          assetBalanceDeltas: yup
            .array(
              yup
                .object({
                  assetId: yup.string().defined(),
                  assetName: yup.string().defined(),
                  delta: yup.string().defined(),
                })
                .defined(),
            )
            .defined(),
        })
        .defined(),
    })
    .defined()

router.register<typeof GetAccountTransactionRequestSchema, GetAccountTransactionResponse>(
  `${ApiNamespace.wallet}/getAccountTransaction`,
  GetAccountTransactionRequestSchema,
  async (request, node): Promise<void> => {
    const account = getAccount(node, request.data.account)

    const transactionHash = Buffer.from(request.data.hash, 'hex')

    const transaction = await account.getTransaction(transactionHash)

    if (!transaction) {
      return request.end({
        account: account.name,
        transaction: null,
      })
    }

    const serializedTransaction = serializeRpcAccountTransaction(transaction)

    const assetBalanceDeltas = await getAssetBalanceDeltas(node, transaction)

    const notes = await getAccountDecryptedNotes(node, account, transaction)

    const status = await node.wallet.getTransactionStatus(account, transaction, {
      confirmations: request.data.confirmations,
    })

    const type = await node.wallet.getTransactionType(account, transaction)

    const serialized = {
      ...serializedTransaction,
      assetBalanceDeltas,
      notes,
      status,
      type,
    }

    request.end({
      account: account.name,
      transaction: serialized,
    })
  },
)
