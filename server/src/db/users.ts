// src/db/users.ts
 
import { randomUUID } from 'crypto';
import { DatabaseContext, User, QueryOptions } from './types';
import { buildWhereClause, buildOrderByClause, parseDate } from './utils';
import { FIRST_USER_HAS_ADMIN } from '../config';
import { Permissions } from '../permissions';

const parseUserRow = (row: any): User => ({
  ...row,
  permissions: JSON.parse(row.permissions),
  createdAt: parseDate(row.createdAt),
  updatedAt: parseDate(row.updatedAt)
});

export function createUsersRepository({ db }: DatabaseContext) {
  const repository = {
    findMany: async (options?: QueryOptions<User>): Promise<User[]> => {
      const { clause: whereClause, params: whereParams } = buildWhereClause('users', options?.where);
      const orderByClause = buildOrderByClause('users', options?.orderBy);

      const query = `
        SELECT * FROM users
        ${whereClause}
        ${orderByClause}
      `;

      const rows = db.prepare(query).all(...whereParams) as any[];
      return rows.map(parseUserRow);
    },

    findUnique: async (where: { id: string }): Promise<User | null> => {
      const row = db.prepare('SELECT * FROM users WHERE id = ?')
        .get(where.id) as any;
      return row ? parseUserRow(row) : null;
    },

    getUserByUsername: async (username: string): Promise<User | null> => {
      const row = db.prepare(
        'SELECT * FROM users WHERE username = ?'
      ).get(username) as any;
      
      if (!row) return null;
      
      return parseUserRow(row);
    },

    createUser: async (username: string, hashedPassword: string, permissions?: string[]): Promise<User> => {
      // Begin transaction
      db.prepare('BEGIN TRANSACTION').run();
      
      try {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        const isFirstUser = userCount.count === 0;
        
        const userPermissions = permissions || (isFirstUser && FIRST_USER_HAS_ADMIN 
          ? [Permissions.ADMIN]
          : [Permissions.USER]);
    
        const user: User = {
          id: randomUUID(),
          username,
          password: hashedPassword,
          permissions: userPermissions,
          createdAt: new Date(),
          updatedAt: new Date()
        };
    
        db.prepare(`
          INSERT INTO users (
            id, username, password, permissions, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          user.id,
          user.username,
          user.password,
          JSON.stringify(user.permissions),
          user.createdAt.toISOString(),
          user.updatedAt.toISOString()
        );
    
        // Create default project for the user
        const defaultProject = {
          id: randomUUID(),
          name: 'Default',
          description: 'Default project',
          userId: user.id,
          createdAt: new Date(),
          updatedAt: new Date()
        };
    
        db.prepare(`
          INSERT INTO projects (
            id, name, description, userId, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          defaultProject.id,
          defaultProject.name,
          defaultProject.description,
          defaultProject.userId,
          defaultProject.createdAt.toISOString(),
          defaultProject.updatedAt.toISOString()
        );
    
        // Commit transaction
        db.prepare('COMMIT').run();
        
        return user;
      } catch (error) {
        // Rollback on error
        db.prepare('ROLLBACK').run();
        throw error;
      }
    },

    updateUser: async (where: { id: string }, data: Partial<User>): Promise<User> => {
      // Direct database query approach - avoids the 'this' binding issue
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(where.id) as any;
      if (!row) throw new Error('User not found');
      
      const current = parseUserRow(row);

      const updated = {
        ...current,
        ...data,
        updatedAt: new Date()
      };

      db.prepare(`
        UPDATE users
        SET username = ?, password = ?, permissions = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        updated.username,
        updated.password,
        JSON.stringify(updated.permissions),
        updated.updatedAt.toISOString(),
        where.id
      );

      return updated;
    },

    updateUserPermissions: async (userId: string, permissions: string[]): Promise<boolean> => {
      try {
        const result = db.prepare(
          'UPDATE users SET permissions = ?, updatedAt = ? WHERE id = ?'
        ).run(JSON.stringify(permissions), new Date().toISOString(), userId);
        return result.changes > 0;
      } catch (err) {
        return false;
      }
    },

    delete: async (where: { id: string }): Promise<void> => {
      const result = db.prepare('DELETE FROM users WHERE id = ?').run(where.id);
      if (result.changes === 0) {
        throw new Error('User not found');
      }
    }
  };

  return repository;
}