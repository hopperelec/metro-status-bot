import {config} from "dotenv";
import {Client, Events, GatewayIntentBits, MessageCreateOptions, MessagePayload, TextChannel} from "discord.js";
import {handleInteraction, registerCommands} from "./commands";
import {MetroApiClient} from "metro-api-client";
import {startMonitoring} from "./monitoring";

config();
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PROXY_BASE_URL = process.env.PROXY_BASE_URL;
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN environment variable must be set");
if (!PROXY_BASE_URL) throw new Error("PROXY_BASE_URL environment variable must be set");

export const proxy = new MetroApiClient(PROXY_BASE_URL);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});
let mainChannel: TextChannel;

client.once(Events.ClientReady, async () => {
    console.log('Bot is ready!');
    await registerCommands(client);
    if (!MAIN_CHANNEL_ID) {
        console.warn("MAIN_CHANNEL_ID environment variable not set, will not monitor trains.");
        return;
    }
    const channel = await client.channels.fetch(MAIN_CHANNEL_ID);
    if (!channel) {
        console.warn("Could not find the main channel, will not monitor trains.");
        return;
    }
    if (!(channel instanceof TextChannel)) {
        console.warn("Main channel must be a text channel, but MAIN_CHANNEL_ID refers to a different type of channel. Will not monitor trains.");
        return;
    }
    mainChannel = channel;
    await startMonitoring();
});

client.on(Events.InteractionCreate, handleInteraction);

export async function updateActivity(numActive: number) {
    client.user.setActivity(
        `${numActive} trains`,
        { type: 3 } // Watching
    );
}

export async function alert(message: string | MessagePayload | MessageCreateOptions) {
    return await mainChannel.send(message);
}

client.login(DISCORD_TOKEN).then();
