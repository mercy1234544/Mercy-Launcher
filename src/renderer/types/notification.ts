// Notification Center data model. Categories map to real subsystems as they
// come online — 'update', 'server', and 'friend' are wired today (see
// useNotifications.ts / useFriendsPresence.ts producers); 'download' and
// 'content' are reserved for when a real download engine / content-manifest
// system exists, so nothing has to be redesigned.
export type NotificationCategory = 'update' | 'server' | 'download' | 'content' | 'system' | 'friend';

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  category: NotificationCategory;
}
