#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0224.lmu", "");
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            if (page.trigger == 1 || page.trigger == 2) {
                std::cout << "Event ID: " << ev.ID << " (X: " << ev.x << ", Y: " << ev.y << ") Trigger: " << page.trigger << "\n";
                for (const auto& cmd : page.event_commands) {
                    std::cout << "    Code " << cmd.code << "\n";
                }
            }
        }
    }
    exit(0);
}
