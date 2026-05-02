import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const imageSourceTypeEnum = ['uploaded', 'generated', 'edited'] as const;
export const imageStatusEnum = ['pending', 'ready', 'failed'] as const;

export const tenantImages = pgTable(
  'tenant_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cfImageId: text('cf_image_id').notNull(),
    url: text('url').notNull(),
    sourceType: text('source_type', { enum: imageSourceTypeEnum }).notNull(),
    status: text('status', { enum: imageStatusEnum }).notNull().default('ready'),
    prompt: text('prompt'),
    sourceImageId: uuid('source_image_id'),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    mimeType: text('mime_type'),
    fileSize: integer('file_size'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCreatedIdx: index('tenant_images_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    taskIdx: index('tenant_images_task_idx').on(table.taskId),
    sourceIdx: index('tenant_images_source_idx').on(table.sourceImageId),
  }),
);

export type TenantImage = typeof tenantImages.$inferSelect;
export type NewTenantImage = typeof tenantImages.$inferInsert;
