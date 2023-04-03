/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Flags } from '@oclif/core'
import fs from 'fs/promises'
import { IronfishCommand } from '../../command'
import { RemoteFlags } from '../../flags'

export default class AirdropPostTransactions extends IronfishCommand {
  static description = `Post transactions for testnet participants`
  static aliases = ['airdrop:post']
  static hidden = true
  static flags = {
    ...RemoteFlags,
    account: Flags.string({
      required: true,
      description: 'The name of the account used to post the transactions',
    }),
    raw: Flags.string({
      required: false,
      default: 'raw_transactions.txt',
      description: 'Input of New line separated raw airdrop transactions',
    }),
    posted: Flags.string({
      required: false,
      default: 'posted_transactions.txt',
      description: 'where to output the posted transactions',
    }),
  }

  async start(): Promise<void> {
    const { flags } = await this.parse(AirdropPostTransactions)
    let lineNum = 0
    const fileContent = await fs.readFile(flags.raw, 'utf-8')
    const lines = fileContent.split(/[\r\n]+/)
    const client = await this.sdk.connectRpc()
    await fs.rm(flags.output)
    const fileHandle = await fs.open(flags.posted, 'a')
    for (const line of lines) {
      const response = await client.wallet.postTransaction({
        account: flags.account,
        transaction: line.trim(),
      })
      lineNum++
      this.log(`Posted transaction ${lineNum} of ${lines.length}`)
      await fs.appendFile(fileHandle, response.content.transaction + '\n')
    }
  }
}
