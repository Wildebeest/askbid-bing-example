import {
    Connection,
    Context,
    KeyedAccountInfo,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction
} from "@solana/web3.js";
import {MintLayout, TOKEN_PROGRAM_ID, Token, AccountLayout} from "@solana/spl-token";
import {
    CreateResult, Deposit,
    Instruction,
    InstructionSchema,
    PROGRAM_ID, ResultAccount, ResultAccountSchema,
    SearchMarketAccount,
    SearchMarketAccountSchema
} from "./lib/client";
import * as borsh from "borsh";
import fetch from 'cross-fetch';

interface BingSearchResponse {
    queryContext: {
        originalQuery: string
    },
    webPages: {
        totalEstimatedMatches: number,
        value: [
            {
                id: string,
                name: string,
                url: string,
                displayUrl: string,
                snippet: string,
                deepLinks: [
                    {
                        name: string,
                        url: string,
                        snippet: string,
                    }
                ]
            }
        ]
    }
}

const SUBSCRIPTION_KEY = process.env.AZURE_SUBSCRIPTION_KEY!;
(async () => {
    const connection = new Connection(process.env.ENDPOINT!);
    const fromWallet = Keypair.generate();
    console.log("Wallet public key: ", fromWallet.publicKey.toString());
    const airdropSig = await connection.requestAirdrop(fromWallet.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig);
    console.log("Airdrop signature: ", airdropSig);
    const onProgramAccountChange = async (keyedAccountInfo: KeyedAccountInfo, _context: Context) => {
        if (keyedAccountInfo.accountInfo.data.compare(new Uint8Array(keyedAccountInfo.accountInfo.data.length)) === 0) {
            return;
        }
        if (keyedAccountInfo.accountInfo.data[0] === 0) {
            const account = borsh.deserialize(SearchMarketAccountSchema, SearchMarketAccount, keyedAccountInfo.accountInfo.data);
            console.log(account);

            const query = encodeURIComponent(account.search_string);
            const response = await fetch("https://api.bing.microsoft.com/v7.0/search?q=" + query, {
                headers: [['Ocp-Apim-Subscription-Key', SUBSCRIPTION_KEY]],
            });
            const bingResponse: BingSearchResponse = await response.json();
            console.log(bingResponse);
            const resultTransactions = bingResponse.webPages.value.map(async webPage => {
                const resultKeypair = Keypair.generate();
                const [mintAuthorityKey, mintAuthorityBumpSeed] = await PublicKey.findProgramAddress(
                    [new Buffer("mint_authority", "ascii")], PROGRAM_ID);
                const createResultData = borsh.serialize(InstructionSchema, new Instruction({
                    instruction: "CreateResult",
                    CreateResult: new CreateResult(webPage.url, webPage.name, webPage.snippet, mintAuthorityBumpSeed),
                }));
                const resultData = borsh.serialize(ResultAccountSchema, new ResultAccount({
                    search_market: keyedAccountInfo.accountId.toBytes(),
                    url: webPage.url,
                    name: webPage.name,
                    snippet: webPage.snippet,
                    yes_mint: PublicKey.default.toBytes(),
                    no_mint: PublicKey.default.toBytes(),
                    bump_seed: mintAuthorityBumpSeed,
                }));
                const rentExemptAmount = await connection.getMinimumBalanceForRentExemption(resultData.byteLength);
                const newResultAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: fromWallet.publicKey,
                    programId: PROGRAM_ID,
                    newAccountPubkey: resultKeypair.publicKey,
                    lamports: rentExemptAmount,
                    space: resultData.byteLength,
                });

                const mintRentExemptAmount = await connection.getMinimumBalanceForRentExemption(MintLayout.span);

                const yesMintKeypair = Keypair.generate();
                const yesMintAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: fromWallet.publicKey,
                    programId: TOKEN_PROGRAM_ID,
                    newAccountPubkey: yesMintKeypair.publicKey,
                    lamports: mintRentExemptAmount,
                    space: MintLayout.span,
                });
                const noMintKeypair = Keypair.generate();
                const noMintAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: fromWallet.publicKey,
                    programId: TOKEN_PROGRAM_ID,
                    newAccountPubkey: noMintKeypair.publicKey,
                    lamports: mintRentExemptAmount,
                    space: MintLayout.span,
                });

                const createResultInstruction = new TransactionInstruction({
                    keys: [
                        {
                            pubkey: resultKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: keyedAccountInfo.accountId,
                            isSigner: false,
                            isWritable: false
                        },
                        {
                            pubkey: yesMintKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: noMintKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: mintAuthorityKey,
                            isSigner: false,
                            isWritable: false,
                        },
                        {
                            pubkey: SYSVAR_RENT_PUBKEY,
                            isSigner: false,
                            isWritable: false,
                        },
                        {
                            pubkey: TOKEN_PROGRAM_ID,
                            isSigner: false,
                            isWritable: false,
                        },
                    ], programId: PROGRAM_ID, data: Buffer.from(createResultData)
                });
                const recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
                const accountCreations = [{
                    instruction: newResultAccountInstruction,
                    keypair: resultKeypair
                }, {
                    instruction: yesMintAccountInstruction,
                    keypair: yesMintKeypair
                }, {instruction: noMintAccountInstruction, keypair: noMintKeypair}].map(async pair => {
                    const {instruction, keypair} = pair;
                    const transaction = (new Transaction({recentBlockhash, feePayer: fromWallet.publicKey}))
                        .add(instruction);
                    const resultSignature = await connection.sendTransaction(transaction, [
                        fromWallet, keypair]);
                    await connection.confirmTransaction(resultSignature);
                });
                await Promise.all(accountCreations);

                const resultTransaction = (new Transaction({recentBlockhash, feePayer: fromWallet.publicKey}))
                    .add(createResultInstruction);
                const resultSignature = await connection.sendTransaction(resultTransaction, [fromWallet]);
                await connection.confirmTransaction(resultSignature);
                console.log("Result signature: ", resultSignature);

                const tokenRentExemptAmount = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);
                const yesTokenKeypair = Keypair.generate();
                const yesTokenAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: fromWallet.publicKey,
                    programId: TOKEN_PROGRAM_ID,
                    newAccountPubkey: yesTokenKeypair.publicKey,
                    lamports: tokenRentExemptAmount,
                    space: AccountLayout.span,
                });
                const yesTokenInstruction = Token.createInitAccountInstruction(
                    TOKEN_PROGRAM_ID, yesMintKeypair.publicKey, yesTokenKeypair.publicKey, fromWallet.publicKey);

                const noTokenKeypair = Keypair.generate();
                const noTokenAccountInstruction = SystemProgram.createAccount({
                    fromPubkey: fromWallet.publicKey,
                    programId: TOKEN_PROGRAM_ID,
                    newAccountPubkey: noTokenKeypair.publicKey,
                    lamports: tokenRentExemptAmount,
                    space: AccountLayout.span,
                });
                const noTokenInstruction = Token.createInitAccountInstruction(
                    TOKEN_PROGRAM_ID, noMintKeypair.publicKey, noTokenKeypair.publicKey, fromWallet.publicKey);

                const depositData = borsh.serialize(InstructionSchema, new Instruction({
                    instruction: "Deposit",
                    Deposit: new Deposit(1),
                }));
                const depositInstruction = new TransactionInstruction({
                    keys: [
                        {
                            pubkey: keyedAccountInfo.accountId,
                            isSigner: false,
                            isWritable: false,
                        },
                        {
                            pubkey: resultKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: fromWallet.publicKey,
                            isSigner: true,
                            isWritable: true,
                        },
                        {
                            pubkey: SystemProgram.programId,
                            isSigner: false,
                            isWritable: false,
                        },
                        {
                            pubkey: TOKEN_PROGRAM_ID,
                            isSigner: false,
                            isWritable: false,
                        },
                        {
                            pubkey: mintAuthorityKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: yesMintKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: yesTokenKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: noMintKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                        {
                            pubkey: noTokenKeypair.publicKey,
                            isSigner: false,
                            isWritable: true,
                        },
                    ], programId: PROGRAM_ID, data: Buffer.from(depositData)
                });

                const depositTransaction = (new Transaction({recentBlockhash, feePayer: fromWallet.publicKey}))
                    .add(yesTokenAccountInstruction)
                    .add(yesTokenInstruction)
                    .add(noTokenAccountInstruction)
                    .add(noTokenInstruction)
                    .add(depositInstruction);
                const depositSignature = await connection.sendTransaction(depositTransaction, [fromWallet, yesTokenKeypair, noTokenKeypair]);
                await connection.confirmTransaction(depositSignature);
                console.log("Deposit signature: ", depositSignature);
            });
            await Promise.all(resultTransactions);
        }
    };
    connection.onProgramAccountChange(PROGRAM_ID, onProgramAccountChange);
})();

import {IncomingMessage, ServerResponse} from "http";

const http = require('http');
http.createServer(function (request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.end('Hello World\n');
}).listen(process.env.PORT);
