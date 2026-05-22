import { z } from 'zod';

export const PostmarkAddressSchema = z.object({
  Email: z.string(),
  Name: z.string().optional().default(''),
  MailboxHash: z.string().optional().default(''),
});

export const PostmarkHeaderSchema = z.object({
  Name: z.string(),
  Value: z.string(),
});

export const PostmarkAttachmentSchema = z.object({
  Name: z.string(),
  Content: z.string(), // base64
  ContentType: z.string(),
  ContentLength: z.number(),
  ContentID: z.string().optional().default(''),
});

export const PostmarkInboundSchema = z.object({
  FromName: z.string().optional().default(''),
  From: z.string(),
  FromFull: PostmarkAddressSchema.optional(),
  To: z.string(),
  ToFull: z.array(PostmarkAddressSchema).default([]),
  Cc: z.string().optional().default(''),
  CcFull: z.array(PostmarkAddressSchema).default([]),
  Bcc: z.string().optional().default(''),
  BccFull: z.array(PostmarkAddressSchema).default([]),
  OriginalRecipient: z.string().optional().default(''),
  Subject: z.string().optional().default(''),
  MessageID: z.string(),
  ReplyTo: z.string().optional().default(''),
  MailboxHash: z.string().optional().default(''),
  Date: z.string().optional().default(''),
  TextBody: z.string().optional().default(''),
  HtmlBody: z.string().optional().default(''),
  StrippedTextReply: z.string().optional().default(''),
  Tag: z.string().optional().default(''),
  Headers: z.array(PostmarkHeaderSchema).default([]),
  Attachments: z.array(PostmarkAttachmentSchema).default([]),
});

export type PostmarkInbound = z.infer<typeof PostmarkInboundSchema>;
