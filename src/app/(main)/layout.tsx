import { Sidebar } from "@/components/layout/Sidebar";
import { Header }  from "@/components/layout/Header";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F7F6F2]">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden md:pl-[240px]">
        <Header />
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="min-h-full p-3 sm:p-6 pb-20 md:pb-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
