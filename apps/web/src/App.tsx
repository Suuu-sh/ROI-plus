import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { OriginProvider } from './lib/origin'
import { OverviewPage } from './pages/Overview'
import { SportPage } from './pages/SportPage'
import { PerformancePage } from './pages/Performance'
import { ModelsPage } from './pages/Models'
import { DataPage } from './pages/Data'

export default function App() {
  return (
    <OriginProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<OverviewPage />} />
            <Route path="horse" element={<SportPage sport="horse" />} />
            <Route path="horse/:raceId" element={<SportPage sport="horse" />} />
            <Route path="boat" element={<SportPage sport="boat" />} />
            <Route path="boat/:raceId" element={<SportPage sport="boat" />} />
            <Route path="performance" element={<PerformancePage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="data" element={<DataPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </OriginProvider>
  )
}
