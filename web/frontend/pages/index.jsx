import {
  Page
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { WelcomeCard } from '../components';

export default function HomePage() {
  return (
    <Page narrowWidth>
      <TitleBar title={("HomePage.title")} />
      <WelcomeCard />
    </Page>
  );
}
