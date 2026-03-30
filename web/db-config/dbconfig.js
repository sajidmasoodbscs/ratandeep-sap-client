import {PostgreSQLSessionStorage} from '@shopify/shopify-app-session-storage-postgresql';
import 'dotenv/config'

export async function createPostgreSQLSessionStorage() {
    try {
    
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is not defined in environment variables.');
      return null;
    }

    const sessionStorage=await new PostgreSQLSessionStorage(
        new URL(`${process.env.DATABASE_URL}`),
      );
  
      
      if (sessionStorage.client.dbUrl.href) {
        console.log('\n\n************************* \n');
        console.log('Database is connected. \n');
        console.log('***********************.\n\n');

      } else {
        console.log('Failed to connect to the database.');
      }
  
      return sessionStorage;
    } catch (error) {
      console.log('Error creating PostgreSQLSessionStorage:', error);
      // throw error;
    }
  }
