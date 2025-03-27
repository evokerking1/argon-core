#!/usr/bin/env bun
// @ts-nocheck
/**
 * Argon CLI
 * Version v1.0.0-dev (Revenant)
 * (c) 2017 - 2025 ether
 */

import { Command } from 'commander';
import { hash } from 'bcrypt';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'child_process';

// Get application root path (resolving symlinks for global installation)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// CLI is in src/cli/cli.ts, so go up two levels to reach project root
const PROJECT_ROOT = join(__dirname, '..', '..');

// Helper function to recursively list files
function listFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    
    if (stat.isDirectory()) {
      results = results.concat(listFilesRecursively(filePath));
    } else {
      results.push(filePath);
    }
  }
  
  return results;
}

// Import the DB and Permissions from their original paths
let db;
let Permissions;

try {
  // Dynamic imports to avoid path issues
  const { DB } = await import(join(PROJECT_ROOT, 'src', 'db.ts'));
  Permissions = (await import(join(PROJECT_ROOT, 'src', 'permissions.ts'))).Permissions;
  
  // Initialize DB with the correct path
  class ArgonDB extends DB {
    constructor() {
      // Pass custom database path to parent constructor
      super(join(PROJECT_ROOT, 'argon.db'));
    }
  }
  
  db = new ArgonDB();
} catch (error) {
  console.error(chalk.red(`Error loading required modules: ${error.message}`));
  console.error(chalk.yellow(`Make sure you're running the CLI from within an Argon project or using the global installation correctly.`));
  process.exit(1);
}

const program = new Command();

// Setup CLI metadata
program
  .name('argon')
  .description('Argon CLI for management')
  .version('v1.0.0-dev (Revenant)');

// User Create Command
program
  .command('user:create')
  .description('Create a new user')
  .option('-u, --username <username>', 'Username for the new user')
  .option('-p, --password <password>', 'Password for the new user')
  .option('-P, --permissions <permissions>', 'Comma-separated list of permissions')
  .action(async (options) => {
    try {
      // If options are not provided, prompt for them
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'username',
          message: 'Enter username:',
          when: !options.username,
          validate: (input) => input.length > 0 ? true : 'Username cannot be empty'
        },
        {
          type: 'password',
          name: 'password',
          message: 'Enter password:',
          when: !options.password,
          mask: '*',
          validate: (input) => input.length >= 8 ? true : 'Password must be at least 8 characters'
        },
        {
          type: 'checkbox',
          name: 'permissions',
          message: 'Select permissions:',
          when: !options.permissions,
          choices: Object.entries(Permissions).map(([key, value]) => ({
            name: key,
            value: value
          }))
        }
      ]);

      const username = options.username || answers.username;
      const password = options.password || answers.password;
      let permissions = options.permissions ? 
        options.permissions.split(',').reduce((acc, perm) => acc | Permissions[perm.trim().toUpperCase()], 0) :
        answers.permissions.reduce((acc, perm) => acc | perm, 0);

      // Check if user already exists
      const existingUser = await db.users.getUserByUsername(username);
      if (existingUser) {
        console.error(chalk.red(`Error: User '${username}' already exists`));
        process.exit(1);
      }

      // Hash password and create user
      const hashedPassword = await hash(password, 10);
      const user = await db.users.createUser(username, hashedPassword, permissions);
      
      console.log(chalk.green('User created successfully:'));
      console.log(chalk.green(`ID: ${user.id}`));
      console.log(chalk.green(`Username: ${user.username}`));
      console.log(chalk.green(`Permissions: ${formatPermissions(user.permissions)}`));
    } catch (error) {
      console.error(chalk.red(`Error creating user: ${error.message}`));
      process.exit(1);
    }
  });

// User Delete Command
program
  .command('user:delete')
  .description('Delete a user')
  .option('-i, --id <id>', 'User ID to delete')
  .option('-u, --username <username>', 'Username to delete')
  .option('-f, --force', 'Force deletion without confirmation')
  .action(async (options) => {
    try {
      if (!options.id && !options.username) {
        const users = await db.users.findMany();
        
        const { userId } = await inquirer.prompt([
          {
            type: 'list',
            name: 'userId',
            message: 'Select user to delete:',
            choices: users.map(user => ({
              name: `${user.username} (ID: ${user.id})`,
              value: user.id
            }))
          }
        ]);
        
        options.id = userId;
      }

      let user;
      if (options.id) {
        user = await db.users.findUnique({ id: options.id });
      } else if (options.username) {
        user = await db.users.getUserByUsername(options.username);
      }

      if (!user) {
        console.error(chalk.red('Error: User not found'));
        process.exit(1);
      }

      if (!options.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to delete user '${user.username}'?`,
            default: false
          }
        ]);

        if (!confirm) {
          console.log(chalk.yellow('Deletion cancelled'));
          process.exit(0);
        }
      }

      await db.users.delete({ id: user.id });
      console.log(chalk.green(`User '${user.username}' deleted successfully`));
    } catch (error) {
      console.error(chalk.red(`Error deleting user: ${error.message}`));
      process.exit(1);
    }
  });

// User Modify Command
program
  .command('user:modify')
  .description('Modify an existing user')
  .option('-i, --id <id>', 'User ID to modify')
  .option('-u, --username <username>', 'Username to modify')
  .option('-n, --new-username <newUsername>', 'New username')
  .option('-p, --password', 'Change password')
  .option('-P, --permissions <permissions>', 'Comma-separated list of permissions')
  .action(async (options) => {
    try {
      if (!options.id && !options.username) {
        const users = await db.users.findMany();
        
        const { userId } = await inquirer.prompt([
          {
            type: 'list',
            name: 'userId',
            message: 'Select user to modify:',
            choices: users.map(user => ({
              name: `${user.username} (ID: ${user.id})`,
              value: user.id
            }))
          }
        ]);
        
        options.id = userId;
      }

      let user;
      if (options.id) {
        user = await db.users.findUnique({ id: options.id });
      } else if (options.username) {
        user = await db.users.getUserByUsername(options.username);
      }

      if (!user) {
        console.error(chalk.red('Error: User not found'));
        process.exit(1);
      }

      const updates: any = {};

      // If no specific modification options are provided, prompt for what to change
      if (!options.newUsername && !options.password && !options.permissions) {
        const { modifications } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'modifications',
            message: 'What would you like to modify?',
            choices: [
              { name: 'Username', value: 'username' },
              { name: 'Password', value: 'password' },
              { name: 'Permissions', value: 'permissions' }
            ]
          }
        ]);

        if (modifications.includes('username')) {
          options.newUsername = true;
        }
        
        if (modifications.includes('password')) {
          options.password = true;
        }

        if (modifications.includes('permissions')) {
          options.permissions = true;
        }
      }

      // Prompt for new username if requested
      if (options.newUsername === true) {
        const { newUsername } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newUsername',
            message: 'Enter new username:',
            default: user.username,
            validate: (input) => input.length > 0 ? true : 'Username cannot be empty'
          }
        ]);
        updates.username = newUsername;
      } else if (typeof options.newUsername === 'string') {
        updates.username = options.newUsername;
      }

      // Prompt for new password if requested
      if (options.password) {
        const { newPassword } = await inquirer.prompt([
          {
            type: 'password',
            name: 'newPassword',
            message: 'Enter new password:',
            mask: '*',
            validate: (input) => input.length >= 8 ? true : 'Password must be at least 8 characters'
          }
        ]);
        updates.password = await hash(newPassword, 10);
      }

      // Handle permissions
      if (options.permissions === true) {
        const { newPermissions } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'newPermissions',
            message: 'Select permissions:',
            choices: Object.entries(Permissions).map(([key, value]) => ({
              name: key,
              value: value,
              checked: Boolean(user.permissions & (value as unknown as number))
            }))
          }
        ]);
        updates.permissions = newPermissions.reduce((acc, perm) => acc | perm, 0);
      } else if (typeof options.permissions === 'string') {
        updates.permissions = options.permissions
          .split(',')
          .reduce((acc, perm) => acc | Permissions[perm.trim().toUpperCase()], 0);
      }

      if (Object.keys(updates).length === 0) {
        console.log(chalk.yellow('No changes requested'));
        process.exit(0);
      }

      const updatedUser = await db.users.updateUser({ id: user.id }, updates);
      console.log(chalk.green('User updated successfully:'));
      console.log(chalk.green(`ID: ${updatedUser.id}`));
      console.log(chalk.green(`Username: ${updatedUser.username}`));
      console.log(chalk.green(`Permissions: ${formatPermissions(updatedUser.permissions)}`));
    } catch (error) {
      console.error(chalk.red(`Error modifying user: ${error.message}`));
      process.exit(1);
    }
  });

// =========== BOLT COMMANDS ===========
// Bolt - Database Management System

// Create a bolt command group
const boltCommand = program
  .command('bolt')
  .description('Argon database management system');

// Bolt SQL command - Interactive SQL shell
boltCommand
  .command('sql')
  .description('Start an interactive SQL shell for the Argon database')
  .option('-q, --query <sql>', 'Execute a single SQL query and exit')
  .action(async (options) => {
    const dbPath = join(PROJECT_ROOT, 'argon.db');
    
    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Database file not found at ${dbPath}`));
      process.exit(1);
    }
    
    if (options.query) {
      // Execute a single query and print results
      try {
        const db = new Database(dbPath);
        const results = db.query(options.query).all();
        console.table(results);
        process.exit(0);
      } catch (error) {
        console.error(chalk.red(`SQL Error: ${error.message}`));
        process.exit(1);
      }
    } else {
      // Start interactive SQL shell
      console.log(chalk.blue('=== Argon Bolt SQL Shell ==='));
      console.log(chalk.blue(`Connected to database: ${dbPath}`));
      console.log(chalk.blue('Enter SQL commands or "exit" to quit'));
      console.log(chalk.blue('-------------------------------'));
      
      const db = new Database(dbPath);
      
      // Simple REPL for SQL
      const repl = async () => {
        try {
          const { sql } = await inquirer.prompt([
            {
              type: 'input',
              name: 'sql',
              message: 'sql> ',
              validate: input => input.trim().length > 0 ? true : 'Please enter a SQL command'
            }
          ]);
          
          if (sql.toLowerCase() === 'exit') {
            console.log(chalk.blue('Goodbye!'));
            process.exit(0);
          }
          
          try {
            const startTime = Date.now();
            const results = db.query(sql).all();
            const duration = Date.now() - startTime;
            
            if (results.length > 0) {
              console.table(results);
            }
            console.log(chalk.green(`Query executed successfully in ${duration}ms (${results.length} rows affected)`));
          } catch (error) {
            console.error(chalk.red(`SQL Error: ${error.message}`));
          }
          
          // Continue REPL
          await repl();
        } catch (error) {
          console.error(chalk.red(`Error: ${error.message}`));
          process.exit(1);
        }
      };
      
      await repl();
    }
  });

// Bolt Migrate command - Database migration
boltCommand
  .command('migrate')
  .description('Run database migrations')
  .option('-c, --create <name>', 'Create a new migration')
  .option('-r, --run', 'Run pending migrations')
  .option('-l, --list', 'List all migrations and their status')
  .option('-f, --force', 'Force run all migrations, even if previously applied')
  .action(async (options) => {
    const migrationsDir = join(PROJECT_ROOT, 'migrations');
    
    // Check if migrations directory exists
    if (!existsSync(migrationsDir)) {
      console.log(chalk.yellow(`Migrations directory not found. Creating at ${migrationsDir}`));
      // Create migrations directory correctly
      try {
        await mkdir(migrationsDir, { recursive: true });
        console.log(chalk.green(`Migrations directory created at ${migrationsDir}`));
      } catch (error) {
        console.error(chalk.red(`Failed to create migrations directory: ${error.message}`));
        process.exit(1);
      }
    }
    
    // Create a new migration file
    if (options.create) {
      const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const migrationName = `${timestamp}_${options.create.replace(/\s+/g, '_')}`;
      const migrationPath = join(migrationsDir, `${migrationName}.ts`);
      
      const migrationTemplate = `/**
 * Migration: ${options.create}
 * Generated: ${new Date().toISOString()}
 */

import { Database } from 'bun:sqlite';

export function up(db: Database) {
  // Write your migration code here
  db.exec(\`
    -- Your SQL to apply changes
  \`);
}

export function down(db: Database) {
  // Write your rollback code here
  db.exec(\`
    -- Your SQL to rollback changes
  \`);
}
`;

      await Bun.write(migrationPath, migrationTemplate);
      console.log(chalk.green(`Migration created at ${migrationPath}`));
      process.exit(0);
    }
    
    // List migrations
    if (options.list) {
      const dbPath = join(PROJECT_ROOT, 'argon.db');
      const db = new Database(dbPath);
      
      // Create migrations table if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL
        );
      `);
      
      // Get applied migrations
      const applied = db.query(`SELECT id FROM migrations`).all() as { id: string }[];
      const appliedIds = new Set(applied.map(m => m.id));
      
      // Get migration files
      const migrationFiles = listFilesRecursively(migrationsDir)
        .filter(file => file.endsWith('.ts'))
        .map(file => {
          const filename = file.split('/').pop() || '';
          const id = filename.split('_')[0];
          const name = filename.replace(/\.ts$/, '').split('_').slice(1).join('_');
          
          return {
            id,
            name,
            filename,
            path: file,
            applied: appliedIds.has(id),
            status: appliedIds.has(id) ? 'Applied' : 'Pending'
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      
      console.log(chalk.blue('=== Argon Migrations ==='));
      console.table(migrationFiles.map(({ id, name, status }) => ({ id, name, status })));
      
      console.log(chalk.blue(`Total: ${migrationFiles.length}, Applied: ${applied.length}, Pending: ${migrationFiles.length - applied.length}`));
      process.exit(0);
    }
    
    // Run migrations
    if (options.run || options.force) {
      const dbPath = join(PROJECT_ROOT, 'argon.db');
      const db = new Database(dbPath);
      
      // Create migrations table if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL
        );
      `);
      
      // Get applied migrations
      const applied = db.query(`SELECT id FROM migrations`).all() as { id: string }[];
      const appliedIds = new Set(applied.map(m => m.id));
      
      // Get migration files
      const migrationFiles = listFilesRecursively(migrationsDir)
        .filter(file => file.endsWith('.ts'))
        .map(file => {
          const filename = file.split('/').pop() || '';
          const id = filename.split('_')[0];
          const name = filename.replace(/\.ts$/, '').split('_').slice(1).join('_');
          
          return {
            id,
            name,
            filename,
            path: file,
            applied: appliedIds.has(id)
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      
      // Filter pending migrations unless --force flag is used
      const migrationsToRun = options.force 
        ? migrationFiles 
        : migrationFiles.filter(m => !m.applied);
      
      if (migrationsToRun.length === 0) {
        console.log(chalk.green('No pending migrations to run.'));
        process.exit(0);
      }
      
      console.log(chalk.blue(`Running ${migrationsToRun.length} migrations...`));
      
      // Run migrations in sequence
      for (const migration of migrationsToRun) {
        try {
          console.log(chalk.blue(`Applying migration: ${migration.name}...`));
          
          if (migration.applied && options.force) {
            console.log(chalk.yellow(`Migration ${migration.id} already applied, rerunning due to --force`));
          }
          
          // Execute the migration script
          // We need to import and run the migration file
          const migrationModule = await import(migration.path);
          
          if (typeof migrationModule.up !== 'function') {
            throw new Error(`Migration ${migration.id} does not export an up() function`);
          }
          
          migrationModule.up(db);
          
          // Record migration as applied
          if (!migration.applied) {
            db.exec(`
              INSERT INTO migrations (id, name, executed_at)
              VALUES (?, ?, ?)
            `, [migration.id, migration.name, new Date().toISOString()]);
          }
          
          console.log(chalk.green(`Migration applied successfully: ${migration.id}`));
        } catch (error) {
          console.error(chalk.red(`Error applying migration ${migration.id}: ${error.message}`));
          process.exit(1);
        }
      }
      
      console.log(chalk.green(`Successfully applied ${migrationsToRun.length} migrations`));
      process.exit(0);
    }
    
    // If no options provided, show help
    if (!options.create && !options.list && !options.run && !options.force) {
      console.log(chalk.yellow('No action specified. Use --help to see available options.'));
      process.exit(1);
    }
  });

// Bolt backup command - Database backup
boltCommand
  .command('backup')
  .description('Backup the Argon database')
  .option('-o, --output <path>', 'Specify backup file path')
  .action(async (options) => {
    const dbPath = join(PROJECT_ROOT, 'argon.db');
    
    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Database file not found at ${dbPath}`));
      process.exit(1);
    }
    
    // Generate backup filename with timestamp if not specified
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const defaultBackupPath = join(PROJECT_ROOT, 'backups', `argon_backup_${timestamp}.db`);
    const backupPath = options.output || defaultBackupPath;
    
    // Create backups directory if it doesn't exist
    const backupsDir = join(PROJECT_ROOT, 'backups');
    if (!existsSync(backupsDir)) {
      console.log(chalk.yellow(`Backups directory not found. Creating at ${backupsDir}`));
      try {
        await mkdir(backupsDir, { recursive: true });
        console.log(chalk.green(`Backups directory created at ${backupsDir}`));
      } catch (error) {
        console.error(chalk.red(`Failed to create backups directory: ${error.message}`));
        process.exit(1);
      }
    }
    
    try {
      // Copy the database file
      await Bun.write(backupPath, Bun.file(dbPath));
      console.log(chalk.green(`Database backup created successfully: ${backupPath}`));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red(`Backup failed: ${error.message}`));
      process.exit(1);
    }
  });

// Bolt info command - Database information
boltCommand
  .command('info')
  .description('Display database information')
  .action(async () => {
    const dbPath = join(PROJECT_ROOT, 'argon.db');
    
    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Database file not found at ${dbPath}`));
      process.exit(1);
    }
    
    try {
      const db = new Database(dbPath);
      
      // Get database size
      const stats = Bun.file(dbPath).size;
      const size = formatBytes(stats);
      
      // Get table information
      const tables = db.query(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as { name: string }[];
      
      const tableInfo = tables.map(table => {
        const count = db.query(`SELECT COUNT(*) as count FROM ${table.name}`).get() as { count: number };
        const columns = db.query(`PRAGMA table_info(${table.name})`).all();
        return {
          name: table.name,
          rowCount: count.count,
          columnCount: columns.length
        };
      });
      
      // Display information
      console.log(chalk.blue('=== Argon Database Information ==='));
      console.log(chalk.blue(`Database file: ${dbPath}`));
      console.log(chalk.blue(`Database size: ${size}`));
      console.log(chalk.blue(`Number of tables: ${tables.length}`));
      
      console.log(chalk.blue('\nTables:'));
      console.table(tableInfo);
      
      process.exit(0);
    } catch (error) {
      console.error(chalk.red(`Error retrieving database information: ${error.message}`));
      process.exit(1);
    }
  });

// =========== DEPLOY COMMAND ===========
// Deploy Command
program
  .command('deploy')
  .description('Deploy Argon with UI')
  .option('-f, --force', 'Skip confirmations')
  .option('-l, --local', 'Force local deployment')
  .option('-d, --domain <domain>', 'Specify domain for production deployment')
  .option('-s, --ssl-path <path>', 'Path to SSL certificates')
  .option('-p, --port <port>', 'API port (default: 3000)')
  .option('-w, --web-port <port>', 'Web server port for local deployment (default: 3001)')
  .option('-c, --config <path>', 'Path to saved configuration')
  .action(async (options) => {
    // Load config if provided
    let config: any = {};
    const configDir = join(PROJECT_ROOT, 'src/cli');
    const defaultConfigPath = join(configDir, 'deploy.json');
    const configPath = options.config || defaultConfigPath;
    
    console.log(configPath)
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
        console.log(chalk.blue(`Loaded configuration from ${configPath}`));
      } catch (error) {
        console.error(chalk.yellow(`Failed to load config from ${configPath}: ${error.message}`));
      }
    }
    
    // Set defaults from config
    options = {
      ...config,
      ...options
    };
    
    // Find argon-ui
    const expectedUIPath = resolve(PROJECT_ROOT, '..', 'argon-ui');
    let uiPath = expectedUIPath;
    
    // Check if argon-ui exists
    if (!options.force && !existsSync(uiPath)) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Please confirm that 'argon-ui' is located in the preceding folder to 'argon-core' (the current directory)`,
          default: true
        }
      ]);
      
      if (!confirm) {
        const { customPath } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customPath',
            message: 'Enter the path to argon-ui:',
            validate: (input) => existsSync(input) ? true : 'Path does not exist'
          }
        ]);
        uiPath = customPath;
      }
    }
    
    console.log(chalk.blue(`Looking for 'argon-ui'...`));
    
    if (!existsSync(uiPath)) {
      console.error(chalk.red(`argon-ui not found at ${uiPath}`));
      process.exit(1);
    }
    
    console.log(chalk.green(`Found argon-ui at ${uiPath}!`));
    
    // Install dependencies
    console.log(chalk.blue(`Installing modules (bun install)...`));
    const installResult = spawnSync('bun', ['install'], { 
      cwd: uiPath,
      stdio: 'inherit'
    });
    
    if (installResult.status !== 0) {
      console.error(chalk.red(`Failed to install dependencies in argon-ui`));
      process.exit(1);
    }
    
    // Determine deployment type
    let deploymentType = options.local ? 'local' : (options.domain ? 'domain' : null);
    
    if (!deploymentType && !options.force) {
      const { deployment } = await inquirer.prompt([
        {
          type: 'list',
          name: 'deployment',
          message: 'Do you have a domain or would you like to run Argon locally?',
          choices: [
            { name: 'Run locally', value: 'local' },
            { name: 'Deploy with domain', value: 'domain' }
          ]
        }
      ]);
      
      deploymentType = deployment;
    }
    
    // Set API port
    const apiPort = options.port || config.port || 3000;
    
    // Configure based on deployment type
    let apiUrl;
    let sslPath;
    let webPort;
    
    if (deploymentType === 'local') {
      console.log(chalk.blue(`Ok, we'll run the API on port ${apiPort} as per defaults`));
      apiUrl = `http://localhost:${apiPort}`;
      webPort = options.webPort || config.webPort || 3001;
    } else {
      let domain = options.domain || config.domain;
      
      if (!domain && !options.force) {
        const { domainAnswer } = await inquirer.prompt([
          {
            type: 'input',
            name: 'domainAnswer',
            message: 'Please enter the domain (e.g., panel.example.com):',
            validate: (input) => input.length > 0 ? true : 'Domain cannot be empty'
          }
        ]);
        
        domain = domainAnswer;
      }
      
      // Check SSL certificates
      let hasSSL = options.sslPath || config.sslPath;
      
      if (!hasSSL && !options.force) {
        const { sslConfirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'sslConfirm',
            message: 'Have you generated a Let\'s Encrypt SSL certificate for your domain?',
            default: false
          }
        ]);
        
        if (sslConfirm) {
          const { sslPathAnswer } = await inquirer.prompt([
            {
              type: 'input',
              name: 'sslPathAnswer',
              message: 'Enter the path to your SSL certificates directory:',
              validate: (input) => existsSync(input) ? true : 'Path does not exist'
            }
          ]);
          
          sslPath = sslPathAnswer;
        } else {
          console.log(chalk.yellow(`Warning: Proceeding without SSL certificates. Your deployment will not be secure.`));
        }
      } else {
        sslPath = options.sslPath || config.sslPath;
        
        if (sslPath) {
          console.log(chalk.blue(`Checking if SSL certificates exist at ${sslPath}...`));
          
          if (!existsSync(sslPath)) {
            console.error(chalk.red(`SSL certificates directory not found at ${sslPath}`));
            process.exit(1);
          }
          
          // Check for key and cert files
          const hasKey = existsSync(join(sslPath, 'privkey.pem'));
          const hasCert = existsSync(join(sslPath, 'fullchain.pem'));
          
          if (!hasKey || !hasCert) {
            console.error(chalk.red(`SSL certificates incomplete. Could not find privkey.pem and/or fullchain.pem in ${sslPath}`));
            process.exit(1);
          }
          
          console.log(chalk.green(`SSL certificates found!`));
        }
      }
      
      apiUrl = `https://${domain}`;
      console.log(chalk.blue(`Ok, we'll run the API on port ${apiPort}, but with the public domain as the API URL`));
    }
    
    // Write .env file for argon-ui
    console.log(chalk.blue(`Writing \`argon-ui\` .env file with "API_URL=${apiUrl}"`));
    
    try {
      writeFileSync(join(uiPath, '.env'), `API_URL=${apiUrl}\n`);
    } catch (error) {
      console.error(chalk.red(`Failed to write .env file: ${error.message}`));
      process.exit(1);
    }
    
    // Build for production
    console.log(chalk.blue(`Building for production...`));
    const buildResult = spawnSync('bun', ['run', 'build'], {
      cwd: uiPath,
      stdio: 'inherit'
    });
    
    if (buildResult.status !== 0) {
      console.error(chalk.red(`Build failed. Please check the build output for errors.`));
      process.exit(1);
    }
    
    // Create _dist directory in argon-core
    const distDir = join(PROJECT_ROOT, '_dist');
    
    if (existsSync(distDir)) {
      console.log(chalk.blue(`Cleaning existing _dist directory...`));
      await rm(distDir, { recursive: true, force: true });
    }
    
    try {
      await mkdir(distDir, { recursive: true });
    } catch (error) {
      console.error(chalk.red(`Failed to create _dist directory: ${error.message}`));
      process.exit(1);
    }
    
    // Copy files from argon-ui/dist to argon-core/_dist
    console.log(chalk.blue(`Copying \`dist\` files from \`argon-ui\` to \`argon-core/_dist\`...`));
    
    const uiDistPath = join(uiPath, 'dist');
    
    if (!existsSync(uiDistPath)) {
      console.error(chalk.red(`Build output not found at ${uiDistPath}`));
      process.exit(1);
    }
    
    const distFiles = listFilesRecursively(uiDistPath);
    
    for (const file of distFiles) {
      const relativePath = file.replace(uiDistPath, '');
      const targetPath = join(distDir, relativePath);
      const targetDir = dirname(targetPath);
      
      if (!existsSync(targetDir)) {
        await mkdir(targetDir, { recursive: true });
      }
      
      await Bun.write(targetPath, Bun.file(file));
    }
    
    console.log(chalk.green(`Done copying files!`));
    
    // Save configuration if requested
    const saveConfig = async () => {
      const config = {
        port: apiPort,
        webPort,
        domain: deploymentType === 'domain' ? options.domain : undefined,
        sslPath,
        uiPath
      };
      
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }
      
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(chalk.green(`Configuration saved to ${configPath}`));
    };
    
    if (!options.force) {
      const { saveConfigConfirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'saveConfigConfirm',
          message: `Would you like to save these settings (${configPath})?`,
          default: true
        }
      ]);
      
      if (saveConfigConfirm) {
        await saveConfig();
      }
    } else {
      await saveConfig();
    }
    
    // Start servers
    console.log(chalk.blue(`Starting servers...`));
    
    // Start API server
    console.log(chalk.blue(`Starting API server on port ${apiPort}...`));
    
    const apiProcess = spawn('bun', ['run', 'start'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: apiPort.toString()
      }
    });
    
    // Start web server with proxy
    if (deploymentType === 'local') {
      console.log(chalk.blue(`Starting web server with API proxy on port ${webPort}...`));
      
      // Create a web server with API proxy using Bun
      const server = Bun.serve({
        port: webPort,
        async fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname;
          
          // Proxy API requests to the API server
          if (path.startsWith('/api/')) {
            // Create a new request to forward to the API server
            const apiUrl = new URL(path, `http://localhost:${apiPort}`);
            
            // Copy search params
            url.searchParams.forEach((value, key) => {
              apiUrl.searchParams.append(key, value);
            });
            
            // Forward the request to the API server
            try {
              const apiResponse = await fetch(apiUrl, {
                method: req.method,
                headers: req.headers,
                body: req.body
              });
              
              // Create a new response with the API response
              return new Response(apiResponse.body, {
                status: apiResponse.status,
                statusText: apiResponse.statusText,
                headers: apiResponse.headers
              });
            } catch (error) {
              console.error(chalk.red(`Error proxying to API: ${error.message}`));
              return new Response(`API server error: ${error.message}`, { status: 502 });
            }
          }
          
          // Serve static files for non-API requests
          let filePath = path;
          
          // Default to index.html for root or client-side routing paths without file extensions
          if (filePath === '/' || (!filePath.includes('.') && !filePath.endsWith('/'))) {
            filePath = '/index.html';
          }
          
          // Try to serve the file from _dist
          const fullPath = join(distDir, filePath);
          
          if (existsSync(fullPath) && statSync(fullPath).isFile()) {
            return new Response(Bun.file(fullPath));
          }
          
          // If we're here and the path doesn't have an extension, it might be a client-side route
          // Serve index.html for client-side routing
          if (!path.includes('.')) {
            return new Response(Bun.file(join(distDir, 'index.html')));
          }
          
          // 404 if file not found
          return new Response('Not Found', { status: 404 });
        },
      });
      
      console.log(chalk.green(`Webserver online on port ${webPort}`));
      console.log(chalk.green(`API proxy is set up to forward /api/* requests to http://localhost:${apiPort}`));
      console.log(chalk.green(`You can access Argon at http://localhost:${webPort}`));
    } else {
      // Production deployment with domain
      console.log(chalk.blue(`Setting up production server with API proxy...`));
      
      let server;
      
      // Check if we have SSL
      if (sslPath) {
        // SSL configuration for HTTPS
        try {
          const keyFile = join(sslPath, 'privkey.pem');
          const certFile = join(sslPath, 'fullchain.pem');
          
          // Read SSL files
          const key = readFileSync(keyFile, 'utf-8');
          const cert = readFileSync(certFile, 'utf-8');
          
          // Create HTTPS server
          server = Bun.serve({
            port: 443,
            tls: {
              key,
              cert
            },
            async fetch(req) {
              const url = new URL(req.url);
              const path = url.pathname;
              
              // Proxy API requests to the API server
              if (path.startsWith('/api/')) {
                // Create a new request to forward to the API server
                const apiUrl = new URL(path, `http://localhost:${apiPort}`);
                
                // Copy search params
                url.searchParams.forEach((value, key) => {
                  apiUrl.searchParams.append(key, value);
                });
                
                // Forward the request to the API server
                try {
                  const apiResponse = await fetch(apiUrl, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body
                  });
                  
                  // Create a new response with the API response
                  return new Response(apiResponse.body, {
                    status: apiResponse.status,
                    statusText: apiResponse.statusText,
                    headers: apiResponse.headers
                  });
                } catch (error) {
                  console.error(chalk.red(`Error proxying to API: ${error.message}`));
                  return new Response(`API server error: ${error.message}`, { status: 502 });
                }
              }
              
              // Serve static files for non-API requests
              let filePath = path;
              
              // Default to index.html for root or client-side routing paths
              if (filePath === '/' || (!filePath.includes('.') && !filePath.endsWith('/'))) {
                filePath = '/index.html';
              }
              
              // Try to serve the file from _dist
              const fullPath = join(distDir, filePath);
              
              if (existsSync(fullPath) && statSync(fullPath).isFile()) {
                return new Response(Bun.file(fullPath));
              }
              
              // If we're here and the path doesn't have an extension, it might be a client-side route
              // Serve index.html for client-side routing
              if (!path.includes('.')) {
                return new Response(Bun.file(join(distDir, 'index.html')));
              }
              
              // 404 if file not found
              return new Response('Not Found', { status: 404 });
            },
          });
          
          // Also set up HTTP to HTTPS redirect on port 80
          Bun.serve({
            port: 80,
            fetch(req) {
              const url = new URL(req.url);
              url.protocol = 'https:';
              url.port = '443';
              
              return new Response(null, {
                status: 301,
                headers: {
                  'Location': url.toString()
                }
              });
            }
          });
          
          console.log(chalk.green(`HTTPS server with SSL running on port 443`));
          console.log(chalk.green(`HTTP to HTTPS redirect running on port 80`));
        } catch (error) {
          console.error(chalk.red(`Failed to start HTTPS server: ${error.message}`));
          console.log(chalk.yellow(`Falling back to HTTP server...`));
          
          // Fall back to HTTP
          setupHttpServer();
        }
      } else {
        // HTTP only setup
        setupHttpServer();
      }
      
      function setupHttpServer() {
        server = Bun.serve({
          port: 80,
          async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;
            
            // Proxy API requests to the API server
            if (path.startsWith('/api/')) {
              // Create a new request to forward to the API server
              const apiUrl = new URL(path, `http://localhost:${apiPort}`);
              
              // Copy search params
              url.searchParams.forEach((value, key) => {
                apiUrl.searchParams.append(key, value);
              });
              
              // Forward the request to the API server
              try {
                const apiResponse = await fetch(apiUrl, {
                  method: req.method,
                  headers: req.headers,
                  body: req.body
                });
                
                // Create a new response with the API response
                return new Response(apiResponse.body, {
                  status: apiResponse.status,
                  statusText: apiResponse.statusText,
                  headers: apiResponse.headers
                });
              } catch (error) {
                console.error(chalk.red(`Error proxying to API: ${error.message}`));
                return new Response(`API server error: ${error.message}`, { status: 502 });
              }
            }
            
            // Serve static files for non-API requests
            let filePath = path;
            
            // Default to index.html for root or client-side routing paths
            if (filePath === '/' || (!filePath.includes('.') && !filePath.endsWith('/'))) {
              filePath = '/index.html';
            }
            
            // Try to serve the file from _dist
            const fullPath = join(distDir, filePath);
            
            if (existsSync(fullPath) && statSync(fullPath).isFile()) {
              return new Response(Bun.file(fullPath));
            }
            
            // If we're here and the path doesn't have an extension, it might be a client-side route
            // Serve index.html for client-side routing
            if (!path.includes('.')) {
              return new Response(Bun.file(join(distDir, 'index.html')));
            }
            
            // 404 if file not found
            return new Response('Not Found', { status: 404 });
          },
        });
        
        console.log(chalk.green(`HTTP server running on port 80`));
      }
      
      console.log(chalk.green(`API proxy is set up to forward /api/* requests to http://localhost:${apiPort}`));
      console.log(chalk.green(`You can access Argon at ${apiUrl.replace('/api', '')}`));
    }
    
    // Handle graceful shutdown
    const cleanup = () => {
      console.log(chalk.blue('\nShutting down servers...'));
      
      // Kill the API process
      if (apiProcess && !apiProcess.killed) {
        apiProcess.kill();
      }
      
      process.exit(0);
    };
    
    // Listen for termination signals
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    
    // Keep the process running
    await new Promise(() => {});
  });

// Helper function to format permissions
function formatPermissions(permissionBitmap: number): string {
  return Object.entries(Permissions)
    .filter(([key, value]) => typeof value === 'number' && (permissionBitmap & value) === value)
    .map(([key]) => key)
    .join(', ');
}

// Helper function to format bytes
function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Parse command line arguments
program.parse();

// Show help if no arguments provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}