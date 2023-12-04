import { Injectable } from '@nestjs/common';
import axios from 'axios';
import config from '@@core/utils/config';
import { PrismaService } from '@@core/prisma/prisma.service';
import { ZendeskOAuthResponse } from '../../types';
import {
  Action,
  NotUniqueRecord,
  handleServiceError,
} from '@@core/utils/errors';
import { LoggerService } from '@@core/logger/logger.service';
import { v4 as uuidv4 } from 'uuid';
import { decrypt, encrypt } from '@@core/utils/crypto';

@Injectable()
export class ZendeskConnectionService {
  constructor(private prisma: PrismaService, private logger: LoggerService) {
    this.logger.setContext(ZendeskConnectionService.name);
  }
  async handleZendeskCallback(
    linkedUserId: string,
    projectId: string,
    code: string,
  ) {
    try {
      const isNotUnique = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
        },
      });
      if (isNotUnique)
        throw new NotUniqueRecord(
          `A connection already exists for userId ${linkedUserId} and the provider zendesk`,
        );
      //reconstruct the redirect URI that was passed in the frontend it must be the same
      const REDIRECT_URI = `${config.OAUTH_REDIRECT_BASE}/connections/oauth/callback`;

      const formData = new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code: code,
      });
      const res = await axios.post(
        'https://api.getbase.com/oauth2/token',
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            Authorization: `Basic ${Buffer.from(
              `${config.ZENDESK_CLIENT_ID}:${config.ZENDESK_CLIENT_SECRET}`,
            ).toString('base64')}`,
          },
        },
      );
      //TODO: handle if res throws an error
      const data: ZendeskOAuthResponse = res.data;
      this.logger.log('OAuth credentials : zendesk ');
      // save tokens for this customer inside our db
      const db_res = await this.prisma.connections.create({
        data: {
          id_connection: uuidv4(),
          provider_slug: 'zendesk',
          token_type: 'oauth',
          access_token: encrypt(data.access_token),
          refresh_token: encrypt(data.refresh_token),
          expiration_timestamp: new Date(
            new Date().getTime() + data.expires_in * 1000,
          ),
          status: 'valid',
          created_at: new Date(),
          projects: {
            connect: { id_project: projectId },
          },
          linked_users: {
            connect: { id_linked_user: linkedUserId },
          },
        },
      });
    } catch (error) {
      handleServiceError(error, this.logger, 'zendesk', Action.oauthCallback);
    }
  }
  async handleZendeskTokenRefresh(connectionId: string, refresh_token: string) {
    try {
      const formData = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decrypt(refresh_token),
      });
      const res = await axios.post(
        'https://api.getbase.com/oauth2/token',
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            Authorization: `Basic ${Buffer.from(
              `${config.ZENDESK_CLIENT_ID}:${config.ZENDESK_CLIENT_SECRET}`,
            ).toString('base64')}`,
          },
        },
      );
      const data: ZendeskOAuthResponse = res.data;
      await this.prisma.connections.update({
        where: {
          id_connection: connectionId,
        },
        data: {
          access_token: encrypt(data.access_token),
          refresh_token: encrypt(data.refresh_token),
          expiration_timestamp: new Date(
            new Date().getTime() + data.expires_in * 1000,
          ),
        },
      });
      this.logger.log('OAuth credentials updated : zendesk ');
    } catch (error) {
      handleServiceError(error, this.logger, 'zendesk', Action.oauthRefresh);
    }
  }
}