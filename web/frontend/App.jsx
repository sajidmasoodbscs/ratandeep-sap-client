import { BrowserRouter } from "react-router-dom";
import Routes from "./Routes";

import { QueryProvider, PolarisProvider } from "./components";

export default function App() {

  const pages = import.meta.glob("./pages/**/!(*.test.[jt]sx)*.([jt]sx)", {
    eager: true,
  });

  return (
    <PolarisProvider>
      <BrowserRouter>
        <QueryProvider>
          <Routes pages={pages} />
        </QueryProvider>
      </BrowserRouter>
    </PolarisProvider>
  );
}
