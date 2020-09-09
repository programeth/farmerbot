import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { App } from '@onboardmoney/sdk';
import { Cron } from '@nestjs/schedule';
import Axios, { AxiosInstance } from "axios";
import Twitter from "twit";

import { Tweet } from './types';
import { DatabaseService } from './database/database.service';
import { CommandService } from './command.service';

@Injectable()
export class BotService {
  app: App;
  axios: AxiosInstance;
  name: string
  twit: Twitter

  constructor(private readonly db: DatabaseService,
    private readonly commandService: CommandService) {
    this.app = new App(
      process.env.OM_API_KEY,
      `https://${process.env.NETWORK}.onboard.money`
    );

    this.axios = Axios.create({
      baseURL: "https://api.twitter.com",
      headers: {
        "Authorization": "Bearer ".concat(process.env.TWITTER_ACCESS_TOKEN)
      }
    })
    if (process.env.BOT_ACCESS_TOKEN && process.env.BOT_ACCESS_TOKEN_SECRET) {
      this.twit = Twitter({
        consumer_key: process.env.TWITTER_API_KEY,
        consumer_secret: process.env.TWITTER_API_KEY_SECRET,
        access_token: process.env.BOT_ACCESS_TOKEN,
        access_token_secret: process.env.BOT_ACCESS_TOKEN_SECRET
      })

    }
  }

  setCredentials(token: string, tokenSecret: string) {
    console.log('credentials', token, tokenSecret)
    this.twit = Twitter({
      consumer_key: process.env.TWITTER_API_KEY,
      consumer_secret: process.env.TWITTER_API_KEY_SECRET,
      access_token: token,
      access_token_secret: tokenSecret
    })
  }
  async processTweet(tweet: Tweet): Promise<void> {
    const words = tweet.text.split(' ')

    // This only supports tweets like "@botname command arg1 arg2 ..."
    // And DO NOT support tweets like  "(n words) @botname command args"
    const [mention, command, ...args] = words;

    let user = await this.db.getUser(tweet.author)

    if (!user) {
      const { userAddress } = await this.app.createUser();
      console.log('user created', userAddress)
      Logger.debug(`wallet created for ${tweet.author}: ${userAddress}`)
      user = await this.db.createUser(tweet.author, userAddress)
      const message = `@${tweet.author_name} send your dai to ${userAddress}`
      // await this.sendDM(tweet.author, message)
      // await this.reply(tweet, message)
    }

    // process the command
    await this.commandService.processCommand(user, command, args)
  }

  // TODO : make this configurable
  @Cron("*/15 * * * * *")
  async process(): Promise<void> {
    // get parsed tweets from redis
    const tweets = await this.db.getTweets()
    Logger.debug(`tweets to process: ${tweets.length}`)
    
    if (tweets.length === 0) return;

    for (const tweet of tweets) {
      await this.processTweet(tweet)
      await this.db.removeTweet(tweet.id)
    }
  }

  private async getTweets(): Promise<Tweet[]> {
    const lastTweetId = await this.db.getLastTweetId();

    // console.log('Fetching tweets since tweet', lastTweetId)
    Logger.debug(`Fetching tweets since tweet: ${lastTweetId}`)

    // craft api call params
    const params = {
      query: "@" + this.name,
      expansions: "entities.mentions.username,author_id",
    }

    if (lastTweetId !== null) {
      params['since_id'] = lastTweetId
    }

    // pull tweets which mention the bot
    const { data } = await this.axios.get('/2/tweets/search/recent', { params })

    const tweets = data.data
    if (tweets === undefined) return [];
    Logger.debug(`Got ${tweets.length} tweets`)

    // get users from every included user entity
    const users = data.includes.users.reduce((obj, item) => {
      return {
        ...obj,
        [item.id]: item.username
      }
    }, {})

    // set the tweet's author's name 
    return tweets.map((t) => {
      if (users[t.author_id] !== undefined) {
        t.author_name = users[t.author_id]
      }
      return t
    })
  }

  private async sendDM(recepient: string, message: string): Promise<any> {
    const params = {
      "event": {
        "type": "message_create",
        "message_create": {
          "target": {
            "recipient_id": recepient
          },
          "message_data": {
            "text": message
          }
        }
      }
    }
    this.twit.post(
      'direct_messages/events/new',
      params,
      (resp, err) => {
        if (err) Logger.error(err)
      }
    )
  }

  private async reply(tweet: Tweet, message: string): Promise<any> {
    const params = {
      status: message,
      in_reply_to_status_id: tweet.id,

    }
    this.twit.post(
      'statuses/update',
      params,
      (err, resp) => {
        if (err) Logger.error(err)
      }
    )
  }
  
  // TODO : make this configurable
  @Cron("*/15 * * * * *")
  async pullTweets() {

    // get tweets
    const tweets = await this.getTweets();

    // parse them
    const parsedTweets = tweets.map(({ id, text, author_id, author_name, entities }) => {
      return {
        id,
        text,
        author_name,
        author: author_id,
      }
    })

    Logger.debug(`Parsed tweets: ${parsedTweets.length}`)

    // store them in redis
    await this.db.addTweets(parsedTweets)
  }
}
