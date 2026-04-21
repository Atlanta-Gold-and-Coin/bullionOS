import { Module } from '@nestjs/common';
import { AdminClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { ClientAttachmentsController } from './client-attachments.controller';
import { ClientAttachmentsService } from './client-attachments.service';

@Module({
  controllers: [AdminClientsController, ClientAttachmentsController],
  providers: [ClientsService, ClientAttachmentsService],
  exports: [ClientsService, ClientAttachmentsService],
})
export class ClientsModule {}
