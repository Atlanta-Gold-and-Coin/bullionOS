import { Module } from '@nestjs/common';
import { AdminUsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
