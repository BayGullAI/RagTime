#!/usr/bin/env node

import { Command } from 'commander';
import { uploadCommand } from './commands/upload';
import { listCommand } from './commands/list';
import { getCommand } from './commands/get';
import { deleteCommand } from './commands/delete';

const program = new Command();

program
  .name('ragtime')
  .description('RagTime CLI for document management')
  .version('1.0.0');

// Add commands
program.addCommand(uploadCommand);
program.addCommand(listCommand);
program.addCommand(getCommand);
program.addCommand(deleteCommand);

program.parse();