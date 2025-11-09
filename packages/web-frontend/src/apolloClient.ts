import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';

const uri = import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:4000/graphql';

export const client = new ApolloClient({
  link: new HttpLink({ uri, credentials: 'include' }),
  cache: new InMemoryCache()
});
