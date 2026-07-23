import { App } from '@slack/bolt';

/**
 * Socket Mode bolt app. No public URL, no request signing — the app-level
 * token (connections:write) opens an outbound websocket, so quackbot runs
 * anywhere: a laptop, a container, a k8s pod.
 */
export function createApp(): App {
  return new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });
}
