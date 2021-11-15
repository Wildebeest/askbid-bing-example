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
    CreateOrder,
    CreateResult, Deposit,
    Instruction,
    InstructionSchema, LAMPORTS_PER_TOKEN, Order, OrderSchema,
    PROGRAM_ID, ResultAccount, ResultAccountSchema,
    SearchMarketAccount,
    SearchMarketAccountSchema
} from "./lib/client";
import * as borsh from "borsh";
import fetch from 'cross-fetch';
import Bugsnag from "@bugsnag/js";
if (process.env.BUGSNAG_API_KEY) {
    Bugsnag.start(process.env.BUGSNAG_API_KEY);
}

interface BingWebPage {
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

interface BingSearchResponse {
    queryContext: {
        originalQuery: string
    },
    webPages: {
        totalEstimatedMatches: number,
        value: [
            BingWebPage
        ]
    }
}

const SUBSCRIPTION_KEY = process.env.AZURE_SUBSCRIPTION_KEY!;
(async () => {
    const connection = new Connection(process.env.ENDPOINT!, 'confirmed');
    const fromWallet = Keypair.generate();
    console.log("Wallet public key: ", fromWallet.publicKey.toString());

    const processWebPage = async (searchMarketPubkey: PublicKey, webPage: BingWebPage, index: number) => {
        const resultKeypair = Keypair.generate();
        const [mintAuthorityKey, mintAuthorityBumpSeed] = await PublicKey.findProgramAddress(
            [new Buffer("mint_authority", "ascii")], PROGRAM_ID);
        const createResultData = borsh.serialize(InstructionSchema, new Instruction({
            instruction: "CreateResult",
            CreateResult: new CreateResult(webPage.url, webPage.name, webPage.snippet, mintAuthorityBumpSeed),
        }));
        const resultData = borsh.serialize(ResultAccountSchema, new ResultAccount({
            search_market: searchMarketPubkey.toBytes(),
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
                    pubkey: searchMarketPubkey,
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
                    pubkey: searchMarketPubkey,
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

        const sellYesOrderKeypair = Keypair.generate();
        const [sellYesEscrowKey, sellYesBumpSeed] = await PublicKey.findProgramAddress(
            [new Buffer("token_escrow", "ascii"), sellYesOrderKeypair.publicKey.toBytes()], PROGRAM_ID);

        const sellYesOrder = new Order({
            search_market: searchMarketPubkey.toBytes(),
            result: resultKeypair.publicKey.toBytes(),
            sol_account: fromWallet.publicKey.toBytes(),
            token_account: yesTokenKeypair.publicKey.toBytes(),
            side: 1,
            price: LAMPORTS_PER_TOKEN * (0.2 - 0.01 * index),
            quantity: 1,
            escrow_bump_seed: sellYesBumpSeed,
            creation_slot: 0,
            execution_authority: fromWallet.publicKey.toBytes(),
        });
        const sellYesOrderData = borsh.serialize(OrderSchema, sellYesOrder);
        const orderRentExemptAmount = await connection.getMinimumBalanceForRentExemption(sellYesOrderData.byteLength);

        const sellOrderAccountInstruction = SystemProgram.createAccount({
            fromPubkey: fromWallet.publicKey,
            programId: PROGRAM_ID,
            newAccountPubkey: sellYesOrderKeypair.publicKey,
            lamports: orderRentExemptAmount,
            space: sellYesOrderData.byteLength,
        });
        const sellYesCreateOrderData = borsh.serialize(InstructionSchema, new Instruction({
            instruction: "CreateOrder",
            CreateOrder: new CreateOrder(sellYesOrder.side, sellYesOrder.price.toNumber(), sellYesOrder.quantity.toNumber(), sellYesOrder.escrow_bump_seed),
        }));

        const sellYesCreateOrderInstruction = new TransactionInstruction({
            keys: [
                {pubkey: sellYesOrderKeypair.publicKey, isWritable: true, isSigner: false},
                {pubkey: searchMarketPubkey, isWritable: false, isSigner: false},
                {pubkey: resultKeypair.publicKey, isWritable: false, isSigner: false},
                {pubkey: fromWallet.publicKey, isWritable: true, isSigner: false},
                {pubkey: yesTokenKeypair.publicKey, isWritable: true, isSigner: false},
                {pubkey: yesMintKeypair.publicKey, isWritable: false, isSigner: false},
                {pubkey: fromWallet.publicKey, isWritable: false, isSigner: true},
                {pubkey: sellYesEscrowKey, isWritable: true, isSigner: false},
                {pubkey: fromWallet.publicKey, isWritable: false, isSigner: true},
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false,
                },
                {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false},
                {
                    pubkey: SystemProgram.programId,
                    isSigner: false,
                    isWritable: false,
                },
            ], programId: PROGRAM_ID, data: Buffer.from(sellYesCreateOrderData)
        });
        const sellYesOrderTransaction = (new Transaction({recentBlockhash, feePayer: fromWallet.publicKey}))
            .add(sellOrderAccountInstruction)
            .add(sellYesCreateOrderInstruction);
        const sellYesOrderSignature = await connection.sendTransaction(sellYesOrderTransaction, [fromWallet, sellYesOrderKeypair]);
        await connection.confirmTransaction(sellYesOrderSignature);
        console.log("Yes Order signature: ", sellYesOrderSignature);
    };

    const airdropConnection = new Connection(process.env.AIRDROP_ENDPOINT || process.env.ENDPOINT!, 'confirmed');
    const onProgramAccountChange = async (keyedAccountInfo: KeyedAccountInfo, _context: Context) => {
        const balance = await airdropConnection.getBalance(fromWallet.publicKey);
        if (balance <= LAMPORTS_PER_SOL * 0.01) {
            const airdropSig = await airdropConnection.requestAirdrop(fromWallet.publicKey, LAMPORTS_PER_SOL);
            await airdropConnection.confirmTransaction(airdropSig);
            console.log("Airdrop signature: ", airdropSig);
        }

        let account: SearchMarketAccount;
        try {
            if (keyedAccountInfo.accountInfo.data.compare(new Uint8Array(keyedAccountInfo.accountInfo.data.length)) === 0) {
                return;
            }
            if (keyedAccountInfo.accountInfo.data[0] === 0) {
                account = borsh.deserialize(SearchMarketAccountSchema, SearchMarketAccount, keyedAccountInfo.accountInfo.data);
                console.log(account);
                const bestResult = new PublicKey(account.best_result);
                if (bestResult.toString() !== PublicKey.default.toString()) {
                    console.log("Decided. Skipping...");
                    return;
                }

                const query = encodeURIComponent(account.search_string);
                const response = await fetch("https://api.bing.microsoft.com/v7.0/search?q=" + query, {
                    headers: [['Ocp-Apim-Subscription-Key', SUBSCRIPTION_KEY]],
                });
                const bingResponse: BingSearchResponse = await response.json();
                console.log(bingResponse);
                const resultTransactions = bingResponse.webPages.value.map((webPage, index) => processWebPage(keyedAccountInfo.accountId, webPage, index));
                await Promise.all(resultTransactions);
            }
        } catch (err) {
            console.error(err);
            if (process.env.BUGSNAG_API_KEY) {
                // @ts-ignore
                Bugsnag.notify(err, (event) => {
                    event.addMetadata("searchMarketId", keyedAccountInfo.accountId);
                    event.addMetadata("searchMarket", account);
                });
            }
        }
    };
    connection.onProgramAccountChange(PROGRAM_ID, onProgramAccountChange);
})();
