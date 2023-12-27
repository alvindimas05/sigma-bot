import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, type WAMessageContent, type WAMessageKey } from '@whiskeysockets/baileys'
import MAIN_LOGGER from '@whiskeysockets/baileys/lib/Utils/logger'
import dotenv from 'dotenv'

dotenv.config()

const logger = MAIN_LOGGER.child({})
logger.level = 'fatal'

const useStore = !process.argv.includes('--no-store')
const usePairingCode = true/* process.argv.includes('--use-pairing-code') */

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		browser: ['Chrome (Linux)', '', ''],
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		let phoneNumber = await question('Please enter your mobile phone number: +')

		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	sock.ev.process(
		async(events) => {
			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						if(!msg.key.fromMe || !msg.key.remoteJid?.includes(process.env.DELETE_NUMBER!)) continue
						setTimeout(() => sock.sendMessage(msg.key.remoteJid!, { delete: msg.key }), parseInt(process.env.DELETE_DELAY!));
					}
				}
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}
startSock()